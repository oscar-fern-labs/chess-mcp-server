import express from 'express';
import { Chess } from 'chess.js';
import { z } from 'zod';
import pg from 'pg';

const { Pool } = pg;

// Env
const PORT = process.env.PORT ? Number(process.env.PORT) : 3456;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_H64qZlJhNbjV@ep-autumn-shadow-ae314gjl-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({ connectionString: DATABASE_URL });

// Simple MCP-like SSE endpoint and JSON tool routes
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Utility: load game
async function loadGame(gameId: string): Promise<{ id: string; fen: string } | null> {
  const { rows } = await pool.query('SELECT id, current_fen as fen FROM chess.games WHERE id = $1', [gameId]);
  return rows[0] || null;
}

// Utility: persist new game
async function createGame(initialFen?: string) {
  const fen = initialFen || new Chess().fen();
  const { rows } = await pool.query(
    'INSERT INTO chess.games (initial_fen, current_fen) VALUES ($1, $1) RETURNING id, current_fen',
    [fen]
  );
  return rows[0];
}

// Utility: record move
async function recordMove(gameId: string, moveNumber: number, san: string, uci: string | null, beforeFen: string, afterFen: string) {
  await pool.query(
    'INSERT INTO chess.moves (game_id, move_number, move_san, move_uci, fen_before, fen_after) VALUES ($1, $2, $3, $4, $5, $6)',
    [gameId, moveNumber, san, uci, beforeFen, afterFen]
  );
}

// Tools
// 1) new_game
app.post('/tools/new_game', async (req, res) => {
  try {
    const schema = z.object({ initial_fen: z.string().optional() });
    const body = schema.parse(req.body || {});
    const game = await createGame(body.initial_fen);
    res.json({ ok: true, game_id: game.id, fen: game.current_fen });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 2) get_board
app.get('/tools/get_board/:id', async (req, res) => {
  try {
    const game = await loadGame(req.params.id);
    if (!game) return res.status(404).json({ ok: false, error: 'game_not_found' });
    res.json({ ok: true, game_id: game.id, fen: game.fen });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 3) legal_moves
app.get('/tools/legal_moves/:id', async (req, res) => {
  try {
    const game = await loadGame(req.params.id);
    if (!game) return res.status(404).json({ ok: false, error: 'game_not_found' });
    const chess = new Chess(game.fen);
    res.json({ ok: true, moves: chess.moves({ verbose: true }) });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 4) make_move
app.post('/tools/make_move', async (req, res) => {
  try {
    const schema = z.object({ id: z.string(), move: z.string() });
    const body = schema.parse(req.body);
    const game = await loadGame(body.id);
    if (!game) return res.status(404).json({ ok: false, error: 'game_not_found' });

    const chess = new Chess(game.fen);
    const before = chess.fen();
    const mv = chess.move(body.move, { sloppy: true });
    if (!mv) return res.status(400).json({ ok: false, error: 'illegal_move' });

    const after = chess.fen();
    // count moves so far
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM chess.moves WHERE game_id = $1', [body.id]);
    const count = rows[0]?.c || 0;

    await pool.query('UPDATE chess.games SET current_fen = $1 WHERE id = $2', [after, body.id]);
    await recordMove(body.id, count + 1, mv.san, (mv as any).lan || null, before, after);

    res.json({ ok: true, fen: after, move: mv.san });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 5) best_move (very naive: pick first legal move)
app.get('/tools/best_move/:id', async (req, res) => {
  try {
    const game = await loadGame(req.params.id);
    if (!game) return res.status(404).json({ ok: false, error: 'game_not_found' });
    const chess = new Chess(game.fen);
    const moves = chess.moves();
    if (!moves.length) return res.json({ ok: true, best_move: null });
    res.json({ ok: true, best_move: moves[0] });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// MCP protocol endpoints (simple)
// Expose a basic discovery route for MCP clients
app.get('/mcp/manifest', (_req, res) => {
  res.json({
    name: 'chess-mcp-server',
    version: '0.1.0',
    tools: [
      { name: 'new_game', method: 'POST', path: '/tools/new_game' },
      { name: 'get_board', method: 'GET', path: '/tools/get_board/:id' },
      { name: 'legal_moves', method: 'GET', path: '/tools/legal_moves/:id' },
      { name: 'make_move', method: 'POST', path: '/tools/make_move' },
      { name: 'best_move', method: 'GET', path: '/tools/best_move/:id' }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`chess-mcp-server listening on :${PORT}`);
});
