import type { FastifyInstance, FastifyRequest } from 'fastify'
import { brotliDecompressSync } from 'node:zlib'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { notFound } from '../utils.js'

type NoteSnapshot = {
  note: {
    id: string
    title: string
    content: string
    folderId: string | null
    isPinned: boolean
    shareToken: string | null
    createdAt: string
    updatedAt: string
  }
  tags: { id: string; name: string }[]
  shares: { id: string; userId: string; permission: 'view' | 'edit'; createdAt: string }[]
}

function userId(req: FastifyRequest): string {
  return req.userId as string
}

function decodeSnapshot(data: Buffer): NoteSnapshot {
  return JSON.parse(brotliDecompressSync(data).toString('utf8')) as NoteSnapshot
}

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preValidation', requireAuth)

  app.get('/', async (req) => {
    const { rows } = await pool.query(
      `SELECT id, original_id, item_type, title, original_size, compressed_size, deleted_at
       FROM trash_items WHERE user_id = $1 ORDER BY deleted_at DESC`,
      [userId(req)],
    )
    return rows.map((row) => ({
      id: row.id,
      originalId: row.original_id,
      type: row.item_type,
      title: row.title,
      originalSize: row.original_size,
      compressedSize: row.compressed_size,
      deletedAt: row.deleted_at,
    }))
  })

  app.post('/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = userId(req)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        'SELECT compressed_data FROM trash_items WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, me],
      )
      if (!locked.rows.length) {
        await client.query('ROLLBACK')
        return notFound(reply, 'Çöp kutusu öğesi bulunamadı')
      }
      const snapshot = decodeSnapshot(locked.rows[0].compressed_data)

      const folder = snapshot.note.folderId
        ? await client.query('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [snapshot.note.folderId, me])
        : null
      const folderId = folder?.rowCount ? snapshot.note.folderId : null

      await client.query(
        `INSERT INTO notes
           (id, title, content, folder_id, is_pinned, share_token, user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          snapshot.note.id,
          snapshot.note.title,
          snapshot.note.content,
          folderId,
          snapshot.note.isPinned,
          snapshot.note.shareToken,
          me,
          snapshot.note.createdAt,
          snapshot.note.updatedAt,
        ],
      )

      for (const tag of snapshot.tags) {
        const existing = await client.query('SELECT id FROM tags WHERE id = $1 AND user_id = $2', [tag.id, me])
        let tagId = existing.rows[0]?.id as string | undefined
        if (!tagId) {
          const byName = await client.query('SELECT id FROM tags WHERE user_id = $1 AND name = $2', [me, tag.name])
          tagId = byName.rows[0]?.id
        }
        if (!tagId) {
          const inserted = await client.query(
            `INSERT INTO tags (id, name, user_id) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [tag.id, tag.name, me],
          )
          tagId = inserted.rows[0].id
        }
        if (tagId) {
          await client.query('INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [snapshot.note.id, tagId])
        }
      }

      for (const share of snapshot.shares) {
        await client.query(
          `INSERT INTO note_shares (id, note_id, user_id, permission, created_at)
           SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM users WHERE id = $3)
           ON CONFLICT (note_id, user_id) DO NOTHING`,
          [share.id, snapshot.note.id, share.userId, share.permission, share.createdAt],
        )
      }

      await client.query('DELETE FROM trash_items WHERE id = $1 AND user_id = $2', [id, me])
      await client.query('COMMIT')
      return { restored: true, noteId: snapshot.note.id }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await pool.query(
      'DELETE FROM trash_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId(req)],
    )
    if (!rows.length) return notFound(reply, 'Çöp kutusu öğesi bulunamadı')
    return reply.code(204).send()
  })
}
