import { useState, useCallback } from 'react';
import { GameShell, GameTopbar, GameAuth, GameButton, useRooms } from '@progamestore/games';

type Piece = 'r' | 'R' | 'b' | 'B' | null;
type Board = Piece[];

type ServerMsg =
  | { type: 'state'; board: Board; turn: string; yourRole: string; opponentConnected: boolean; gameOver: { reason: string; winner: string | null } | null }
  | { type: 'move'; from: number; to: number; captures: number[]; board: Board; turn: string; gameOver: { reason: string; winner: string | null } | null; mustContinue?: number }
  | { type: 'opponent_joined' }
  | { type: 'opponent_left' }
  | { type: 'new_game' }
  | { type: 'error'; message: string };

type ClientMsg =
  | { type: 'move'; from: number; to: number }
  | { type: 'resign' }
  | { type: 'new_game' };

function sqFromRowCol(row: number, col: number): number | null {
  if (row < 0 || row > 7 || col < 0 || col > 7) return null;
  if ((row + col) % 2 === 0) return null;
  return row * 4 + Math.floor(col / 2);
}

export default function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState('');
  const [board, setBoard] = useState<Board>(new Array(32).fill(null));
  const [turn, setTurn] = useState('b');
  const [opponentConnected, setOpponentConnected] = useState(false);
  const [gameOver, setGameOver] = useState<{ reason: string; winner: string | null } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [mustContinue, setMustContinue] = useState<number | null>(null);
  const [error, setError] = useState('');

  const room = useRooms<ServerMsg, ClientMsg>({
    gameId: 'checkers',
    roomId,
    onMessage(msg) {
      if (msg.type === 'state') {
        setBoard(msg.board);
        setTurn(msg.turn);
        setMyRole(msg.yourRole);
        setOpponentConnected(msg.opponentConnected);
        setGameOver(msg.gameOver);
        setMustContinue(null);
        setSelected(null);
      }
      if (msg.type === 'move') {
        setBoard(msg.board);
        setTurn(msg.turn);
        setGameOver(msg.gameOver);
        setMustContinue(msg.mustContinue ?? null);
        setSelected(null);
      }
      if (msg.type === 'opponent_joined') setOpponentConnected(true);
      if (msg.type === 'opponent_left') setOpponentConnected(false);
      if (msg.type === 'error') { setError(msg.message); setTimeout(() => setError(''), 2000); }
    },
  });

  const myColor = myRole === 'red' ? 'r' : myRole === 'black' ? 'b' : null;
  const isMyTurn = myColor === turn && !gameOver;

  const handleSquareClick = useCallback((sq: number) => {
    if (!isMyTurn) return;

    const piece = board[sq];
    const pieceIsOurs = piece && piece.toLowerCase() === myColor;

    if (mustContinue !== null) {
      // Must continue jumping from mustContinue square
      if (sq === mustContinue) { setSelected(sq); return; }
      if (selected === mustContinue) {
        room.send({ type: 'move', from: mustContinue, to: sq });
        return;
      }
      setSelected(mustContinue);
      return;
    }

    if (selected === null) {
      if (pieceIsOurs) setSelected(sq);
      return;
    }

    if (sq === selected) { setSelected(null); return; }
    if (pieceIsOurs) { setSelected(sq); return; }

    // Try to move
    room.send({ type: 'move', from: selected, to: sq });
  }, [isMyTurn, board, myColor, selected, mustContinue, room]);

  if (!roomId) {
    return (
      <GameShell topbar={<GameTopbar title="Checkers" />}>
        <GameAuth />
        <Lobby
          onCreate={async () => { const id = await room.create(); setRoomId(id); }}
          onJoin={setRoomId}
        />
      </GameShell>
    );
  }

  const statusText = gameOver
    ? gameOver.winner === myColor ? 'You win!' : gameOver.winner ? 'You lose' : 'Draw'
    : !opponentConnected ? 'Waiting for opponent...'
    : isMyTurn ? 'Your turn' : "Opponent's turn";

  return (
    <GameShell topbar={<GameTopbar title="Checkers" stats={[{ label: 'Status', value: statusText }]} />}>
      <GameAuth />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '0.5rem', padding: '0.5rem' }}>
        {!opponentConnected && (
          <p style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>
            Share room code: <strong>{roomId}</strong>
          </p>
        )}
        {error && <p style={{ color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}
        <BoardView
          board={board}
          selected={selected}
          flipped={myRole === 'red'}
          onClick={handleSquareClick}
        />
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {gameOver && <GameButton variant="primary" onClick={() => room.send({ type: 'new_game' })}>New Game</GameButton>}
          {!gameOver && opponentConnected && <GameButton variant="ghost" onClick={() => room.send({ type: 'resign' })}>Resign</GameButton>}
        </div>
      </div>
    </GameShell>
  );
}

function Lobby({ onCreate, onJoin }: { onCreate: () => void; onJoin: (id: string) => void }) {
  const [joinId, setJoinId] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '1rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800 }}>Checkers</h1>
      <p style={{ color: 'var(--muted)' }}>Multiplayer checkers on ProGameStore</p>
      <GameButton variant="primary" size="lg" onClick={onCreate}>Create Room</GameButton>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input value={joinId} onChange={(e) => setJoinId(e.target.value)} placeholder="Room code"
          style={{ padding: '0.5rem', borderRadius: '0.5rem', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--ink)' }} />
        <GameButton variant="secondary" onClick={() => joinId && onJoin(joinId)}>Join</GameButton>
      </div>
    </div>
  );
}

function BoardView({ board, selected, flipped, onClick }: {
  board: Board; selected: number | null; flipped: boolean; onClick: (sq: number) => void;
}) {
  const size = Math.min(typeof window !== 'undefined' ? window.innerWidth - 32 : 400, 400);
  const cellSize = size / 8;

  const cells: React.ReactNode[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const displayRow = flipped ? 7 - row : row;
      const displayCol = flipped ? 7 - col : col;
      const isDark = (displayRow + displayCol) % 2 === 1;
      const sq = isDark ? sqFromRowCol(displayRow, displayCol) : null;
      const piece = sq !== null ? board[sq] : null;
      const isSelected = sq !== null && sq === selected;

      cells.push(
        <div
          key={`${row}-${col}`}
          onClick={() => sq !== null && onClick(sq)}
          style={{
            width: cellSize, height: cellSize,
            background: isSelected ? '#7c3aed44' : isDark ? '#8b6914' : '#f5deb3',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: isDark ? 'pointer' : 'default',
            position: 'relative',
          }}
        >
          {piece && (
            <div style={{
              width: cellSize * 0.75, height: cellSize * 0.75,
              borderRadius: '50%',
              background: piece.toLowerCase() === 'r' ? '#dc2626' : '#1a1a1a',
              border: `3px solid ${piece.toLowerCase() === 'r' ? '#fca5a5' : '#555'}`,
              boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: cellSize * 0.3, fontWeight: 900, color: '#ffd700',
            }}>
              {(piece === 'R' || piece === 'B') && 'K'}
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(8, ${cellSize}px)`,
      border: '3px solid var(--border)', borderRadius: '0.5rem', overflow: 'hidden',
    }}>
      {cells}
    </div>
  );
}
