import { DurableObject } from 'cloudflare:workers';

const ID_RE = /^[a-z0-9]{6,12}$/;

function randomId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// --- Checkers Engine ---
// 8x8 board, 32 playable dark squares.
// Pieces: 'r'=red, 'R'=red king, 'b'=black, 'B'=black king, null=empty.
// Black starts top (rows 0-2), red starts bottom (rows 5-7). Black moves first.

type Piece = 'r' | 'R' | 'b' | 'B' | null;
type Board = Piece[];
type Color = 'r' | 'b';

function initialBoard(): Board {
  const board: Board = new Array(32).fill(null);
  for (let i = 0; i < 12; i++) board[i] = 'b';
  for (let i = 20; i < 32; i++) board[i] = 'r';
  return board;
}

function getRow(sq: number): number { return Math.floor(sq / 4); }
function getCol(sq: number): number {
  const row = getRow(sq);
  return (sq % 4) * 2 + (row % 2 === 0 ? 1 : 0);
}
function sqFromRowCol(row: number, col: number): number | null {
  if (row < 0 || row > 7 || col < 0 || col > 7) return null;
  if ((row + col) % 2 === 0) return null;
  return row * 4 + Math.floor(col / 2);
}

function pieceColor(p: Piece): Color | null {
  if (!p) return null;
  return p.toLowerCase() === 'r' ? 'r' : 'b';
}
function isKing(p: Piece): boolean { return p === 'R' || p === 'B'; }

interface Move { from: number; to: number; captures: number[]; }

function getMoves(board: Board, sq: number): Move[] {
  const piece = board[sq];
  if (!piece) return [];
  const color = pieceColor(piece)!;
  const king = isKing(piece);
  const row = getRow(sq);
  const col = getCol(sq);

  const dirs: [number, number][] = [];
  if (color === 'b' || king) dirs.push([1, -1], [1, 1]);
  if (color === 'r' || king) dirs.push([-1, -1], [-1, 1]);

  const moves: Move[] = [];
  for (const [dr, dc] of dirs) {
    const nr = row + dr;
    const nc = col + dc;
    const target = sqFromRowCol(nr, nc);
    if (target === null) continue;
    if (!board[target]) {
      moves.push({ from: sq, to: target, captures: [] });
    } else if (pieceColor(board[target]) !== color) {
      const jr = nr + dr;
      const jc = nc + dc;
      const jumpTarget = sqFromRowCol(jr, jc);
      if (jumpTarget !== null && !board[jumpTarget]) {
        moves.push({ from: sq, to: jumpTarget, captures: [target] });
      }
    }
  }
  return moves;
}

function getAllMoves(board: Board, color: Color): Move[] {
  const allMoves: Move[] = [];
  for (let sq = 0; sq < 32; sq++) {
    if (pieceColor(board[sq]) !== color) continue;
    allMoves.push(...getMoves(board, sq));
  }
  const jumps = allMoves.filter(m => m.captures.length > 0);
  return jumps.length > 0 ? jumps : allMoves;
}

function applyMove(board: Board, move: Move): Board {
  const b = [...board];
  b[move.to] = b[move.from];
  b[move.from] = null;
  for (const c of move.captures) b[c] = null;
  if (b[move.to] === 'b' && getRow(move.to) === 7) b[move.to] = 'B';
  if (b[move.to] === 'r' && getRow(move.to) === 0) b[move.to] = 'R';
  return b;
}

function checkGameOver(board: Board, turn: Color): { reason: string; winner: string | null } | null {
  if (getAllMoves(board, turn).length === 0) {
    return { reason: 'no moves', winner: turn === 'r' ? 'b' : 'r' };
  }
  return null;
}

// --- Durable Object ---

type PlayerRole = 'red' | 'black' | 'spectator';

interface Player { ws: WebSocket; role: PlayerRole; }

export class GameDO extends DurableObject {
  players: Player[] = [];
  board: Board = initialBoard();
  turn: Color = 'b';
  gameOver: { reason: string; winner: string | null } | null = null;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = pair;
    server.accept();

    const taken = new Set(this.players.map(p => p.role));
    const role: PlayerRole = !taken.has('black') ? 'black' : !taken.has('red') ? 'red' : 'spectator';

    if (role !== 'spectator') {
      this.players.push({ ws: server, role });
      this.broadcast({ type: 'opponent_joined' }, server);
    }

    this.send(server, {
      type: 'state', board: this.board, turn: this.turn,
      yourRole: role, opponentConnected: this.players.length === 2, gameOver: this.gameOver,
    });

    server.addEventListener('message', (e) => this.onMessage(server, e.data as string));
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws: WebSocket, data: string): void {
    let msg: { type: string; from?: number; to?: number };
    try { msg = JSON.parse(data); } catch { return; }

    const player = this.players.find(p => p.ws === ws);
    if (!player || player.role === 'spectator') return;
    const playerColor: Color = player.role === 'red' ? 'r' : 'b';

    if (msg.type === 'move' && typeof msg.from === 'number' && typeof msg.to === 'number') {
      if (this.gameOver) return this.send(ws, { type: 'error', message: 'Game is over' });
      if (this.turn !== playerColor) return this.send(ws, { type: 'error', message: 'Not your turn' });

      const legal = getAllMoves(this.board, playerColor);
      const move = legal.find(m => m.from === msg.from && m.to === msg.to);
      if (!move) return this.send(ws, { type: 'error', message: 'Illegal move' });

      this.board = applyMove(this.board, move);

      // Multi-jump: if this was a capture, check for continuation jumps from landing square
      if (move.captures.length > 0) {
        const continuations = getMoves(this.board, move.to).filter(m => m.captures.length > 0);
        if (continuations.length > 0) {
          this.broadcast({
            type: 'move', from: move.from, to: move.to, captures: move.captures,
            board: this.board, turn: this.turn, gameOver: null, mustContinue: move.to,
          });
          return;
        }
      }

      this.turn = this.turn === 'r' ? 'b' : 'r';
      this.gameOver = checkGameOver(this.board, this.turn);
      this.broadcast({
        type: 'move', from: move.from, to: move.to, captures: move.captures,
        board: this.board, turn: this.turn, gameOver: this.gameOver,
      });
      return;
    }

    if (msg.type === 'resign') {
      if (this.gameOver) return;
      this.gameOver = { reason: 'resigned', winner: playerColor === 'r' ? 'b' : 'r' };
      this.broadcast({ type: 'move', board: this.board, turn: this.turn, gameOver: this.gameOver });
      return;
    }

    if (msg.type === 'new_game') {
      this.board = initialBoard();
      this.turn = 'b';
      this.gameOver = null;
      for (const p of this.players) {
        this.send(p.ws, {
          type: 'state', board: this.board, turn: this.turn,
          yourRole: p.role, opponentConnected: this.players.length === 2, gameOver: null,
        });
      }
    }
  }

  onClose(ws: WebSocket): void {
    this.players = this.players.filter(p => p.ws !== ws);
    this.broadcast({ type: 'opponent_left' });
  }

  send(ws: WebSocket, msg: Record<string, unknown>): void {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  broadcast(msg: Record<string, unknown>, except?: WebSocket): void {
    for (const p of this.players) {
      if (p.ws !== except) this.send(p.ws, msg);
    }
  }
}

// --- Worker ---
// Multiplayer API only. Static SPA is served from R2 by the host worker.

interface Env {
  GAME: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS for cross-origin WebSocket + fetch from the R2-hosted SPA
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    if (url.pathname === '/api/rooms/new') {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      return Response.json({ roomId: randomId() }, { headers: corsHeaders });
    }

    const wsMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/ws$/);
    if (wsMatch) {
      const id = wsMatch[1];
      if (!ID_RE.test(id)) return new Response('Invalid room id', { status: 400 });
      const doId = env.GAME.idFromName(id);
      const obj = env.GAME.get(doId);
      return obj.fetch(req);
    }

    return new Response('Not found', { status: 404 });
  },
};
