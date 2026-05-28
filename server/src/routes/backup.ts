import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { db } from '../db.js'
import { env } from '../env.js'

const router = Router()

/** GET /api/backup
 *  Retorna tar.gz com:
 *    - planilha.db (snapshot consistente via SQLite Online Backup API)
 *    - images/    (diretório inteiro do volume)
 *
 *  Pensado pra ser chamado por cron externo (Dokploy schedule, GitHub
 *  Actions, etc) que arquiva o resultado fora do servidor. */
router.get('/backup', requireAuth, async (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tempDir = mkdtempSync(path.join(tmpdir(), 'planilha-backup-'))
  const snapshotPath = path.join(tempDir, 'planilha.db')

  let snapshotDone = false
  try {
    // 1) Snapshot consistente do SQLite (lida com WAL/checkpoint).
    //    db.backup() retorna Promise.
    await db.backup(snapshotPath)
    snapshotDone = true

    res.setHeader('content-type', 'application/gzip')
    res.setHeader(
      'content-disposition',
      `attachment; filename="planilha-backup-${stamp}.tar.gz"`,
    )

    // 2) tar -czf - planilha.db images/  (relativo a paths que controlamos)
    //    Estrutura final: ./planilha.db + ./images/*
    const imagesDir = path.join(env.dataDir, 'images')
    mkdirSync(imagesDir, { recursive: true })

    const tar = spawn(
      'tar',
      [
        '-czf', '-',
        '-C', tempDir, 'planilha.db',
        '-C', env.dataDir, 'images',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    tar.stdout.pipe(res)

    let stderrBuf = ''
    tar.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
    })

    const cleanup = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }

    tar.on('error', (err) => {
      console.error('[backup] tar spawn error:', err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'tar não disponível no container' })
      } else {
        res.destroy(err)
      }
      cleanup()
    })

    tar.on('close', (code) => {
      cleanup()
      if (code !== 0) {
        console.error(`[backup] tar exit ${code}: ${stderrBuf.slice(0, 500)}`)
        if (!res.writableEnded) {
          res.destroy(new Error(`tar exit ${code}`))
        }
      }
    })

    req.on('close', () => {
      if (!tar.killed) tar.kill('SIGTERM')
    })
  } catch (error) {
    console.error('[backup] erro:', error)
    if (snapshotDone) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: (error as Error).message ?? 'erro ao gerar backup' })
    } else {
      res.destroy(error as Error)
    }
  }
})

export default router
