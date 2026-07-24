// Battle Helper: a plain square grid, click to select a square.
// Each square represents 5 ft, per PF2e's grid convention — see the
// pf2e-battle-grid skill for the rules this page will grow into
// (tokens, movement/reach, initiative, flanking, cover).

const canvas = document.getElementById("battle-grid");
const ctx = canvas.getContext("2d");
const selectionLabel = document.getElementById("battle-selection-label");

const COLS = 24;
const ROWS = 16;
const SQUARE_SIZE = 40;

canvas.width = COLS * SQUARE_SIZE;
canvas.height = ROWS * SQUARE_SIZE;

let selected = null; // { row, col }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function draw() {
  const surface = cssVar("--surface");
  const border = cssVar("--border");
  const accent = cssVar("--accent");
  const accentSoft = cssVar("--accent-soft");

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (selected) {
    ctx.fillStyle = accentSoft;
    ctx.fillRect(selected.col * SQUARE_SIZE, selected.row * SQUARE_SIZE, SQUARE_SIZE, SQUARE_SIZE);
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  for (let col = 0; col <= COLS; col++) {
    const x = col * SQUARE_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let row = 0; row <= ROWS; row++) {
    const y = row * SQUARE_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  if (selected) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(selected.col * SQUARE_SIZE + 1, selected.row * SQUARE_SIZE + 1, SQUARE_SIZE - 2, SQUARE_SIZE - 2);
  }
}

// Maps a click's page coordinates to a grid square, accounting for the
// canvas being CSS-scaled (max-width: 100%) away from its internal
// COLS*SQUARE_SIZE resolution.
function squareFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const col = Math.floor(x / SQUARE_SIZE);
  const row = Math.floor(y / SQUARE_SIZE);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return { row, col };
}

canvas.addEventListener("click", (event) => {
  const square = squareFromEvent(event);
  if (!square) return;
  selected = square;
  selectionLabel.textContent = `Selected square: row ${square.row + 1}, column ${square.col + 1}`;
  draw();
});

draw();
