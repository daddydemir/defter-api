import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { pool } from '../db.js'
import { mapNote, notFound, badRequest, forbidden } from '../utils.js'
import { requireAuth } from '../auth.js'
import { getLimits, MAX_TITLE_LENGTH } from '../limits.js'

const LIST_SELECT = `
  n.id, n.title, n.content, n.folder_id, f.name AS folder_name,
  n.is_pinned, n.created_at, n.updated_at, n.share_token,
  CASE WHEN n.user_id = $1 THEN 'owner' ELSE COALESCE(ns.permission, 'none') END AS permission,
  (SELECT u.username FROM users u WHERE u.id = n.user_id) AS shared_by_username,
  COALESCE(
    json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
      FILTER (WHERE t.id IS NOT NULL),
    '[]'::json
  ) AS tags
`

const LIST_JOINS = `
  FROM notes n
  LEFT JOIN folders f ON f.id = n.folder_id
  LEFT JOIN note_shares ns ON ns.note_id = n.id AND ns.user_id = $1
  LEFT JOIN note_tags nt ON nt.note_id = n.id
  LEFT JOIN tags t ON t.id = nt.tag_id
`

type ListQuery = { search?: string; folderId?: string; tagId?: string; view?: string }

function userId(req: FastifyRequest): string {
  return req.userId as string
}

type Access = 'owner' | 'edit' | 'view' | 'none'

// Not erişimini döndürür; var olmayan not için 'none'
async function accessFor(noteId: string, uid: string): Promise<{ access: Access }> {
  const { rows } = await pool.query(
    `SELECT n.user_id, ns.permission AS share_permission
     FROM notes n
     LEFT JOIN note_shares ns ON ns.note_id = n.id AND ns.user_id = $2
     WHERE n.id = $1`,
    [noteId, uid],
  )
  if (!rows.length) return { access: 'none' }
  if (rows[0].user_id === uid) return { access: 'owner' }
  return { access: rows[0].share_permission ?? 'none' }
}

export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preValidation', requireAuth)

  app.get('/', async (req) => {
    const { search, folderId, tagId, view } = req.query as ListQuery
    const where: string[] = [`(n.user_id = $1 OR ns.note_id IS NOT NULL)`]
    const params: unknown[] = [userId(req)]
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }

    if (search) {
      where.push(`(n.title ILIKE ${p(`%${search}%`)} OR n.content ILIKE ${p(`%${search}%`)})`)
    }
    if (folderId) where.push(`n.folder_id = ${p(folderId)}`)
    if (tagId) where.push(`n.id IN (SELECT note_id FROM note_tags WHERE tag_id = ${p(tagId)})`)
    if (view === 'pinned') where.push('n.is_pinned = true')

    const whereSql = `WHERE ${where.join(' AND ')}`
    const { rows } = await pool.query<NoteRowLike>(
      `SELECT ${LIST_SELECT} ${LIST_JOINS} ${whereSql}
       GROUP BY n.id, f.name, ns.permission
       ORDER BY n.is_pinned DESC, n.updated_at DESC
       LIMIT 500`,
      params,
    )
    return rows.map(mapNote)
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = userId(req)
    const { access } = await accessFor(id, me)
    if (access === 'none') return notFound(reply)
    const { rows } = await pool.query<NoteRowLike>(
      `SELECT ${LIST_SELECT} ${LIST_JOINS} WHERE n.id = $2 GROUP BY n.id, f.name, ns.permission`,
      [me, id],
    )
    if (!rows.length) return notFound(reply)
    return mapNote(rows[0])
  })

  app.post('/', async (req, reply) => {
    const { title, content, folderId, isPinned, tagIds } = req.body as {
      title?: string
      content?: string
      folderId?: string | null
      isPinned?: boolean
      tagIds?: string[]
    }

    const titleText = title?.trim() || 'Untitled'
    const bodyText = content ?? ''
    const { maxNotes, maxNoteChars } = await getLimits(userId(req))
    if (titleText.length > MAX_TITLE_LENGTH) {
      return badRequest(reply, `Başlık en fazla ${MAX_TITLE_LENGTH} karakter olabilir`)
    }
    if (bodyText.length > maxNoteChars) {
      return forbidden(reply, `Not içeriği en fazla ${maxNoteChars.toLocaleString('tr-TR')} karakter olabilir`)
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Kötüye kullanım koruması: kullanıcı başına not sayısı sınırı
      const { rows: cnt } = await client.query(
        'SELECT count(*)::int AS c FROM notes WHERE user_id = $1',
        [userId(req)],
      )
      if (cnt[0].c >= maxNotes) {
        await client.query('ROLLBACK')
        return forbidden(reply, `Not sınırına ulaştınız (en fazla ${maxNotes.toLocaleString('tr-TR')} not)`)
      }

      let safeFolder = folderId ?? null
      if (safeFolder) {
        const f = await client.query('SELECT 1 FROM folders WHERE id = $1 AND user_id = $2', [
          safeFolder,
          userId(req),
        ])
        if (!f.rowCount) safeFolder = null
      }
      const { rows } = await client.query(
        `INSERT INTO notes (title, content, folder_id, is_pinned, user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, title, content, folder_id, is_pinned, created_at, updated_at,
           (SELECT name FROM folders WHERE id = folder_id) AS folder_name`,
        [titleText, bodyText, safeFolder, isPinned ?? false, userId(req)],
      )
      const note = rows[0]
      if (tagIds && tagIds.length) {
        await client.query(
          `INSERT INTO note_tags (note_id, tag_id)
           SELECT $1, t.id FROM tags t WHERE t.id = ANY($2::uuid[]) AND t.user_id = $3`,
          [note.id, tagIds, userId(req)],
        )
      }
      await client.query('COMMIT')
      return reply.code(201).send(mapNote({ ...note, tags: [] }))
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = userId(req)
    const body = req.body as {
      title?: string
      content?: string
      folderId?: string | null
      isPinned?: boolean
      tagIds?: string[]
    }

    const { access } = await accessFor(id, me)
    if (access === 'none') return notFound(reply)
    if (access === 'view') return forbidden(reply, 'Read-only note')

    // Yalnızca sahip klasör/sabitleme/etiket değiştirebilir
    if (access !== 'owner' && (body.folderId !== undefined || body.isPinned !== undefined || body.tagIds !== undefined)) {
      return forbidden(reply, 'Only the owner can change folder, pin or tags')
    }

    // Kötüye kullanım koruması: içerik ve başlık boyutu sınırı
    if (body.title !== undefined && body.title.trim().length > MAX_TITLE_LENGTH) {
      return badRequest(reply, `Başlık en fazla ${MAX_TITLE_LENGTH} karakter olabilir`)
    }
    if (body.content !== undefined) {
      const { maxNoteChars } = await getLimits(me)
      if (body.content.length > maxNoteChars) {
        return forbidden(reply, `Not içeriği en fazla ${maxNoteChars.toLocaleString('tr-TR')} karakter olabilir`)
      }
    }

    const sets: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }

    if (body.title !== undefined) sets.push(`title = ${p(body.title.trim() || 'Untitled')}`)
    if (body.content !== undefined) sets.push(`content = ${p(body.content)}`)
    if (body.folderId !== undefined) sets.push(`folder_id = ${p(body.folderId || null)}`)
    if (body.isPinned !== undefined) sets.push(`is_pinned = ${p(body.isPinned)}`)
    if (body.tagIds !== undefined && body.tagIds.length > 100) {
      return badRequest(reply, 'Too many tags')
    }
    if (!sets.length && body.tagIds === undefined) return badRequest(reply, 'No fields to update')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Kullanıcıya ait olmayan bir klasöre taşımayı engelle
      if (body.folderId) {
        const f = await client.query('SELECT 1 FROM folders WHERE id = $1 AND user_id = $2', [
          body.folderId,
          me,
        ])
        if (!f.rowCount) {
          await client.query('ROLLBACK')
          return badRequest(reply, 'Folder not found')
        }
      }

      let updated: NoteRowLike | undefined
      if (sets.length) {
        params.push(id, me)
        const { rows } = await client.query(
          `UPDATE notes SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $${params.length - 1} AND (user_id = $${params.length} OR EXISTS (
             SELECT 1 FROM note_shares WHERE note_id = notes.id AND user_id = $${params.length} AND permission = 'edit'
           ))
           RETURNING id, title, content, folder_id, is_pinned, created_at, updated_at`,
          params,
        )
        if (!rows.length) {
          await client.query('ROLLBACK')
          return notFound(reply)
        }
        updated = rows[0]
      } else {
        const { rows } = await client.query(
          `SELECT id, title, content, folder_id, is_pinned, created_at, updated_at
           FROM notes WHERE id = $1 AND (user_id = $2 OR EXISTS (
             SELECT 1 FROM note_shares WHERE note_id = notes.id AND user_id = $2 AND permission = 'edit'
           ))`,
          [id, me],
        )
        if (!rows.length) {
          await client.query('ROLLBACK')
          return notFound(reply)
        }
        updated = rows[0]
      }

      if (body.tagIds !== undefined) {
        await client.query('DELETE FROM note_tags WHERE note_id = $1', [id])
        if (body.tagIds.length) {
          await client.query(
            `INSERT INTO note_tags (note_id, tag_id)
             SELECT $1, t.id FROM tags t WHERE t.id = ANY($2::uuid[]) AND t.user_id = $3`,
            [id, body.tagIds, me],
          )
        }
      }

      await client.query('COMMIT')

      const { rows } = await pool.query<NoteRowLike>(
        `SELECT ${LIST_SELECT} ${LIST_JOINS} WHERE n.id = $2 GROUP BY n.id, f.name, ns.permission`,
        [me, id],
      )
      return mapNote(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = userId(req)
    const { access } = await accessFor(id, me)
    if (access !== 'owner') return access === 'none' ? notFound(reply) : forbidden(reply)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const noteResult = await client.query(
        `SELECT id, title, content, folder_id, is_pinned, share_token, created_at, updated_at
         FROM notes WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, me],
      )
      if (!noteResult.rows.length) {
        await client.query('ROLLBACK')
        return notFound(reply)
      }
      const note = noteResult.rows[0]
      const [tagResult, shareResult] = await Promise.all([
        client.query(
          `SELECT t.id, t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id
           WHERE nt.note_id = $1 ORDER BY t.name`,
          [id],
        ),
        client.query(
          `SELECT id, user_id, permission, created_at FROM note_shares
           WHERE note_id = $1 ORDER BY created_at`,
          [id],
        ),
      ])
      const snapshot = {
        note: {
          id: note.id,
          title: note.title,
          content: note.content,
          folderId: note.folder_id,
          isPinned: note.is_pinned,
          shareToken: note.share_token,
          createdAt: note.created_at,
          updatedAt: note.updated_at,
        },
        tags: tagResult.rows,
        shares: shareResult.rows.map((share) => ({
          id: share.id,
          userId: share.user_id,
          permission: share.permission,
          createdAt: share.created_at,
        })),
      }
      const raw = Buffer.from(JSON.stringify(snapshot), 'utf8')
      const compressed = brotliCompressSync(raw, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
      })
      await client.query(
        `INSERT INTO trash_items
           (user_id, original_id, item_type, title, compressed_data, compression, original_size, compressed_size)
         VALUES ($1, $2, 'note', $3, $4, 'brotli', $5, $6)`,
        [me, id, note.title, compressed, raw.length, compressed.length],
      )
      await client.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, me])
      await client.query('COMMIT')
      return reply.code(204).send()
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  // ---------- Paylaşım yönetimi (yalnızca sahip) ----------

  app.get('/:id/shares', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { access } = await accessFor(id, userId(req))
    if (access === 'none') return notFound(reply)
    if (access !== 'owner') return forbidden(reply)
    const { rows } = await pool.query(
      `SELECT ns.id, ns.permission, ns.user_id, u.username, ns.created_at
       FROM note_shares ns JOIN users u ON u.id = ns.user_id
       WHERE ns.note_id = $1
       ORDER BY u.username`,
      [id],
    )
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      permission: r.permission,
      createdAt: r.created_at,
    }))
  })

  app.post('/:id/shares', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = userId(req)
    const { userId: shareUserId, permission } = req.body as {
      userId?: string
      permission?: string
    }
    if (!shareUserId) return badRequest(reply, 'userId is required')
    if (permission !== 'view' && permission !== 'edit') {
      return badRequest(reply, 'permission must be view or edit')
    }
    const { access } = await accessFor(id, me)
    if (access === 'none') return notFound(reply)
    if (access !== 'owner') return forbidden(reply)

    const { rows } = await pool.query(
      `SELECT ns.id, ns.permission FROM note_shares ns
       WHERE ns.note_id = $1 AND ns.user_id = $2`,
      [id, shareUserId],
    )
    if (rows.length) {
      await pool.query(`UPDATE note_shares SET permission = $1 WHERE id = $2`, [permission, rows[0].id])
      return { id: rows[0].id, permission }
    }

    const isFriend = await pool.query(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
      [me, shareUserId],
    )
    if (!isFriend.rowCount) return badRequest(reply, 'Only friends can be added to a note')

    const ins = await pool.query(
      `INSERT INTO note_shares (note_id, user_id, permission) VALUES ($1, $2, $3) RETURNING id`,
      [id, shareUserId, permission],
    )
    return reply.code(201).send({ id: ins.rows[0].id, permission })
  })

  app.patch('/:id/shares/:shareId', async (req, reply) => {
    const { id, shareId } = req.params as { id: string; shareId: string }
    const { permission } = req.body as { permission?: string }
    if (permission !== 'view' && permission !== 'edit') {
      return badRequest(reply, 'permission must be view or edit')
    }
    const { access } = await accessFor(id, userId(req))
    if (access === 'none') return notFound(reply)
    if (access !== 'owner') return forbidden(reply)

    const { rows } = await pool.query(
      `UPDATE note_shares SET permission = $1
       WHERE id = $2 AND note_id = $3 RETURNING id`,
      [permission, shareId, id],
    )
    if (!rows.length) return notFound(reply, 'Share not found')
    return { id: rows[0].id, permission }
  })

  app.delete('/:id/shares/:shareId', async (req, reply) => {
    const { id, shareId } = req.params as { id: string; shareId: string }
    const { access } = await accessFor(id, userId(req))
    if (access === 'none') return notFound(reply)
    if (access !== 'owner') return forbidden(reply)

    const { rows } = await pool.query(
      `DELETE FROM note_shares WHERE id = $1 AND note_id = $2 RETURNING id`,
      [shareId, id],
    )
    if (!rows.length) return notFound(reply, 'Share not found')
    return reply.code(204).send()
  })

  // ---------- Herkese açık bağlantı paylaşımı (yalnızca sahip) ----------

  app.post('/:id/share', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = userId(req)
    const { access } = await accessFor(id, me)
    if (access === 'none') return notFound(reply)
    if (access !== 'owner') return forbidden(reply)

    const { rows } = await pool.query(
      `UPDATE notes SET share_token = COALESCE(share_token, $2)
       WHERE id = $1 AND user_id = $3
       RETURNING share_token`,
      [id, randomBytes(24).toString('base64url'), me],
    )
    if (!rows.length) return notFound(reply)
    return { shareToken: rows[0].share_token }
  })

  app.delete('/:id/share', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = userId(req)
    const { access } = await accessFor(id, me)
    if (access === 'none') return notFound(reply)
    if (access !== 'owner') return forbidden(reply)

    await pool.query('UPDATE notes SET share_token = NULL WHERE id = $1 AND user_id = $2', [id, me])
    return reply.code(204).send()
  })
}

type NoteRowLike = {
  id: string
  title: string
  content: string
  folder_id: string | null
  folder_name: string | null
  is_pinned: boolean
  created_at: string
  updated_at: string
  permission?: string
  shared_by_username?: string | null
  tags: { id: string; name: string }[]
}
