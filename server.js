const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '100kb' }));

const frontendUrl = process.env.FRONTEND_URL || '*';
app.use(cors({
  origin: frontendUrl === '*' ? true : frontendUrl,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// Tokens de administrador ficam somente na memória do serviço.
// Reiniciar o Web Service invalida os tokens existentes.
const adminTokens = new Map();
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

async function inicializarBanco() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não foi configurada.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS respostas (
      id BIGSERIAL PRIMARY KEY,
      resposta_id TEXT UNIQUE NOT NULL,
      data_envio TIMESTAMPTZ NOT NULL,
      turma TEXT NOT NULL,
      p1_sofreu TEXT,
      p2_presenciou TEXT,
      p3_locais JSONB NOT NULL DEFAULT '[]'::jsonb,
      p4_tipos_agressao JSONB NOT NULL DEFAULT '[]'::jsonb,
      p5_afeta_saude_emocional TEXT,
      p6_sabe_denunciar TEXT,
      p7_piadas_como_brincadeira TEXT,
      p8_ajuda_vitima TEXT,
      p9_escola_faz_suficiente TEXT,
      p10_sugestao TEXT
    );
  `);
}

function autenticar(req, res, next) {
  const cabecalho = req.get('Authorization') || '';
  const token = cabecalho.startsWith('Bearer ')
    ? cabecalho.slice(7)
    : '';

  const expiracao = adminTokens.get(token);

  if (!token || !expiracao || expiracao < Date.now()) {
    if (token) adminTokens.delete(token);
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  next();
}

function texto(valor, max = 2000) {
  if (typeof valor !== 'string') return '';
  return valor.trim().slice(0, max);
}

function lista(valor, maxItens = 20) {
  if (!Array.isArray(valor)) return [];
  return valor
    .filter(item => typeof item === 'string')
    .map(item => item.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, maxItens);
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (_err) {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/login', (req, res) => {
  const senhaCorreta = process.env.ADMIN_PASSWORD;

  if (!senhaCorreta) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD não configurada no servidor.' });
  }

  if (req.body?.senha !== senhaCorreta) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + TOKEN_TTL_MS);

  res.json({ token });
});

app.post('/api/respostas', async (req, res) => {
  try {
    const r = req.body || {};

    const respostaId = texto(r.id, 100);
    const dataEnvio = texto(r.dataEnvio, 100);
    const turma = texto(r.turma, 100);

    if (!respostaId || !dataEnvio || !turma) {
      return res.status(400).json({ error: 'Dados obrigatórios ausentes.' });
    }

    const data = new Date(dataEnvio);
    if (Number.isNaN(data.getTime())) {
      return res.status(400).json({ error: 'Data inválida.' });
    }

    const p1 = texto(r.p1_sofreu, 100);
    const p2 = texto(r.p2_presenciou, 100);
    const p3 = lista(r.p3_locais);
    const p4 = lista(r.p4_tipos_agressao);
    const p5 = texto(r.p5_afeta_saude_emocional, 100);
    const p6 = texto(r.p6_sabe_denunciar, 100);
    const p7 = texto(r.p7_piadas_como_brincadeira, 100);
    const p8 = texto(r.p8_ajuda_vitima, 100);
    const p9 = texto(r.p9_escola_faz_suficiente, 100);
    const p10 = texto(r.p10_sugestao, 5000);

    await pool.query(
      `INSERT INTO respostas (
        resposta_id, data_envio, turma, p1_sofreu, p2_presenciou,
        p3_locais, p4_tipos_agressao, p5_afeta_saude_emocional,
        p6_sabe_denunciar, p7_piadas_como_brincadeira,
        p8_ajuda_vitima, p9_escola_faz_suficiente, p10_sugestao
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (resposta_id) DO NOTHING`,
      [
        respostaId,
        data.toISOString(),
        turma,
        p1,
        p2,
        JSON.stringify(p3),
        JSON.stringify(p4),
        p5,
        p6,
        p7,
        p8,
        p9,
        p10
      ]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Erro ao salvar resposta:', err.message);
    res.status(500).json({ error: 'Erro interno ao salvar a resposta.' });
  }
});

app.get('/api/respostas', autenticar, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        resposta_id AS id,
        data_envio AS "dataEnvio",
        turma,
        p1_sofreu,
        p2_presenciou,
        p3_locais,
        p4_tipos_agressao,
        p5_afeta_saude_emocional,
        p6_sabe_denunciar,
        p7_piadas_como_brincadeira,
        p8_ajuda_vitima,
        p9_escola_faz_suficiente,
        p10_sugestao
      FROM respostas
      ORDER BY data_envio ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar respostas:', err.message);
    res.status(500).json({ error: 'Erro interno ao buscar as respostas.' });
  }
});

app.delete('/api/respostas', autenticar, async (_req, res) => {
  try {
    await pool.query('DELETE FROM respostas');
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao apagar respostas:', err.message);
    res.status(500).json({ error: 'Erro interno ao apagar as respostas.' });
  }
});

setInterval(() => {
  const agora = Date.now();
  for (const [token, expiracao] of adminTokens.entries()) {
    if (expiracao < agora) adminTokens.delete(token);
  }
}, 30 * 60 * 1000).unref();

inicializarBanco()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`API Efeito Harmonia rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Falha ao inicializar:', err.message);
    process.exit(1);
  });
