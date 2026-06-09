import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Router } from 'express'
import multer from 'multer'

import { requireAuth } from '../auth.js'
import { db } from '../db.js'
import { env } from '../env.js'

const router = Router()

const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, _file, cb) => cb(null, `planilha-restore-${Date.now()}.tar.gz`),
  }),
  limits: { fileSize: 600 * 1024 * 1024 }, // 600 MB
})

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

/** POST /api/restore
 *  Restaura um backup gerado pelo GET /api/backup.
 *  Body: multipart/form-data com campo "backup" (arquivo tar.gz).
 *  Query: ?mode=full (default) | db-only
 *    - full:    substitui planilha.db + images/
 *    - db-only: substitui só planilha.db (mantém images/ atual)
 *
 *  Ao concluir, o processo reinicia via process.exit(0) para que o Docker
 *  relance o container com o banco novo em memória limpa.
 */
router.post('/restore', requireAuth, uploadMiddleware.single('backup'), async (req, res) => {
  const mode = (req.query.mode as string) === 'db-only' ? 'db-only' : 'full'
  const file = req.file

  if (!file) {
    res.status(400).json({ error: 'campo "backup" obrigatório (tar.gz)' })
    return
  }

  const tarPath = file.path

  const runTar = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar exit ${code}: ${stderr.slice(0, 300)}`))
      })
    })

  try {
    // Verifica que o arquivo contém planilha.db antes de fechar o banco.
    const tempCheck = mkdtempSync(path.join(tmpdir(), 'planilha-restore-check-'))
    try {
      await runTar(['-xzf', tarPath, '-C', tempCheck, '--wildcards', 'planilha.db'])
      if (!existsSync(path.join(tempCheck, 'planilha.db'))) {
        throw new Error('planilha.db não encontrado no backup')
      }
    } finally {
      rmSync(tempCheck, { recursive: true, force: true })
    }

    // A partir daqui não há mais volta — fechar o banco e substituir.
    db.close()

    if (mode === 'full') {
      const imagesDir = path.join(env.dataDir, 'images')
      rmSync(imagesDir, { recursive: true, force: true })
      mkdirSync(imagesDir, { recursive: true })
      // Extrai planilha.db + images/ direto em dataDir
      await runTar(['-xzf', tarPath, '-C', env.dataDir])
    } else {
      // db-only: só sobrescreve planilha.db
      await runTar(['-xzf', tarPath, '-C', env.dataDir, '--wildcards', 'planilha.db'])
    }

    console.log(`[restore] modo=${mode} concluído — reiniciando processo`)
    res.json({ ok: true, mode, message: `Restore ${mode} concluído. Reiniciando...` })

    // Dá tempo da resposta ser enviada antes de sair.
    setTimeout(() => {
      try { unlinkSync(tarPath) } catch { /* ignore */ }
      process.exit(0)
    }, 400)
  } catch (error) {
    console.error('[restore] erro:', error)
    try { unlinkSync(tarPath) } catch { /* ignore */ }
    if (!res.headersSent) {
      res.status(500).json({ error: (error as Error).message ?? 'erro ao restaurar backup' })
    }
  }
})

export default router
