// src/catmode.js — Canvas-drawn dancing cats with beat-reactive bars

const TWO_PI     = Math.PI * 2;
const BAR_COUNT  = 24;
const BAR_AREA_H = 128;            // px — beat bar zone at screen bottom
const GRAVITY    = 780;            // px/s² — for jump physics
const JUMP_VEL   = -195;           // px/s — upward impulse on beat
const WALK_SPEED = 115;            // px/s

const SLOTS  = [0.17, 0.37, 0.63, 0.83]; // fractional x positions
const COLORS = ['#e8834f', '#9a9a9a', '#4a4a58', '#f2dbb5'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function rrPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y,         x + r, y);
  ctx.closePath();
}

function fillRR(ctx, x, y, w, h, r) { rrPath(ctx, x, y, w, h, r); ctx.fill(); }

// ── Cat drawing ───────────────────────────────────────────────────────────────

function drawCat(ctx, x, groundY, color, flip, jumpOff, tailPhase, footPhase, walking) {
  ctx.save();
  ctx.translate(x, groundY + jumpOff);
  if (flip) ctx.scale(-1, 1);

  const BW = 78, BH = 52, headR = 33;
  const headY = -(BH + headR - 7);          // head center Y (upward from feet)
  const isDark = color === '#4a4a58';        // charcoal cat gets light eyes

  // Floor shadow — squishes when airborne
  const squat = Math.max(0.2, 1 - Math.abs(jumpOff) / 55);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.scale(1, 0.2);
  ctx.beginPath();
  ctx.ellipse(0, 5, BW * 0.44 * squat, 14 * squat, 0, 0, TWO_PI);
  ctx.fill();
  ctx.restore();

  // ── Tail (behind body) ─────────────────────────────────────────────────────
  const ts = Math.sin(tailPhase) * 0.9;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 10;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  const tx = BW * 0.40, ty = -BH * 0.52;
  ctx.moveTo(tx, ty);
  ctx.quadraticCurveTo(tx + 30 + ts * 18, ty - 25, tx + 10 + ts * 42, ty - 62);
  ctx.stroke();
  // Tail tip — lighter shade
  ctx.lineWidth   = 5;
  ctx.strokeStyle = isDark ? '#7a7a90' : color + 'cc';
  ctx.beginPath();
  ctx.moveTo(tx + 18 + ts * 32, ty - 50);
  ctx.quadraticCurveTo(tx + 10 + ts * 42, ty - 62, tx + 4 + ts * 50, ty - 74);
  ctx.stroke();
  ctx.restore();

  // ── Body ───────────────────────────────────────────────────────────────────
  ctx.fillStyle = color;
  fillRR(ctx, -BW / 2, -BH, BW, BH, 20);

  // Belly highlight for warm-colored cats
  if (color === '#e8834f') {
    ctx.fillStyle = '#f5a97c';
    fillRR(ctx, -BW * 0.28, -BH + 6, BW * 0.56, BH - 14, 13);
  } else if (color === '#f2dbb5') {
    ctx.fillStyle = '#fdf3e3';
    fillRR(ctx, -BW * 0.28, -BH + 6, BW * 0.56, BH - 14, 13);
  }

  // ── Legs ───────────────────────────────────────────────────────────────────
  const bob = walking ? Math.sin(footPhase) * 5 : Math.sin(footPhase * 0.5) * 1;
  ctx.fillStyle = color;
  fillRR(ctx, -BW * 0.36,  -5, 16, 24 + bob, 5);
  fillRR(ctx,  BW * 0.20,  -5, 16, 24 - bob, 5);

  // ── Head ───────────────────────────────────────────────────────────────────
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, headY, headR, 0, TWO_PI);
  ctx.fill();

  // ── Ears ───────────────────────────────────────────────────────────────────
  for (const side of [-1, 1]) {
    // Three vertices of the outer ear triangle
    const ex = side * headR * 0.58, ey = headY - headR * 0.68;  // base (toward center)
    const tx_ = side * headR * 0.9, ty_ = headY - headR - 22;   // tip
    const bx  = side * headR * 0.15, by_ = headY - headR * 0.84; // inner base

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ex, ey); ctx.lineTo(tx_, ty_); ctx.lineTo(bx, by_);
    ctx.closePath(); ctx.fill();

    // Pink inner ear — scaled toward centroid
    const cx_ = (ex + tx_ + bx) / 3, cy_ = (ey + ty_ + by_) / 3;
    const k   = 0.68;
    ctx.fillStyle = '#f09ab0';
    ctx.beginPath();
    ctx.moveTo(lerp(cx_, ex, k), lerp(cy_, ey, k));
    ctx.lineTo(lerp(cx_, tx_, k), lerp(cy_, ty_, k));
    ctx.lineTo(lerp(cx_, bx, k), lerp(cy_, by_, k));
    ctx.closePath(); ctx.fill();
  }

  // ── Eyes ───────────────────────────────────────────────────────────────────
  const eyeWhite = isDark ? '#d0d0e0' : '#111';
  const pupilCol = isDark ? '#8888a0' : '#000';
  for (const side of [-1, 1]) {
    ctx.fillStyle = eyeWhite;
    ctx.beginPath(); ctx.arc(side * headR * 0.36, headY - headR * 0.1, 5.5, 0, TWO_PI); ctx.fill();
    ctx.fillStyle = pupilCol;
    ctx.beginPath(); ctx.arc(side * headR * 0.36, headY - headR * 0.1, 3.2, 0, TWO_PI); ctx.fill();
  }
  // Eye shines
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(-headR * 0.28, headY - headR * 0.18, 2, 0, TWO_PI); ctx.fill();
  ctx.beginPath(); ctx.arc( headR * 0.44, headY - headR * 0.18, 2, 0, TWO_PI); ctx.fill();

  // ── Nose ───────────────────────────────────────────────────────────────────
  ctx.fillStyle = '#e07878';
  ctx.beginPath();
  ctx.moveTo(0,  headY + headR * 0.14);
  ctx.lineTo(-5, headY + headR * 0.27);
  ctx.lineTo( 5, headY + headR * 0.27);
  ctx.closePath(); ctx.fill();

  // ── Mouth ──────────────────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1.8; ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 4, headY + headR * 0.29);
    ctx.quadraticCurveTo(side * 11, headY + headR * 0.41, side * 6, headY + headR * 0.40);
    ctx.stroke();
  }

  // ── Whiskers ───────────────────────────────────────────────────────────────
  const whiskerCol = isDark ? 'rgba(230,230,255,0.75)' : 'rgba(100,100,100,0.55)';
  ctx.strokeStyle = whiskerCol;
  ctx.lineWidth   = 1.5;
  for (const side of [-1, 1]) {
    for (let wi = 0; wi < 3; wi++) {
      ctx.beginPath();
      ctx.moveTo(side * 9, headY + headR * (0.16 + wi * 0.07));
      ctx.lineTo(side * 36, headY + headR * (0.10 + wi * 0.08));
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ── Beat bars ─────────────────────────────────────────────────────────────────

function drawBeatBars(ctx, bars, x, y, w, h, hue) {
  const slotW = w / bars.length;
  const barW  = slotW * 0.62;
  const rBar  = Math.min(barW / 2, 6);

  for (let i = 0; i < bars.length; i++) {
    const bh   = Math.max(rBar * 2 + 1, bars[i].h * h);
    const bx   = x + i * slotW + (slotW - barW) / 2;
    const by   = y + h - bh;
    const alph = 0.40 + bars[i].h * 0.60;

    ctx.fillStyle = `hsla(${hue}, 78%, 60%, ${alph})`;
    ctx.beginPath();
    ctx.moveTo(bx + rBar, by);
    ctx.lineTo(bx + barW - rBar, by);
    ctx.arcTo(bx + barW, by, bx + barW, by + rBar, rBar);
    ctx.lineTo(bx + barW, y + h);
    ctx.lineTo(bx, y + h);
    ctx.lineTo(bx, by + rBar);
    ctx.arcTo(bx, by, bx + rBar, by, rBar);
    ctx.closePath();
    ctx.fill();
  }
}

// ── CatMode class ─────────────────────────────────────────────────────────────

export class CatMode {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.active = false;
    this.energy = 0.5;

    this._t         = 0;
    this._W         = 0;
    this._H         = 0;
    this._groundY   = 0;
    this._rafId     = null;
    this._lastTs    = 0;
    this._beatCount = 0;
    this._nextWalk  = 9 + Math.floor(Math.random() * 5);

    this.bars = Array.from({ length: BAR_COUNT }, () => ({
      h:      0.12,
      target: 0.12,
      phase:  Math.random() * TWO_PI,
    }));

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize(); // also inits canvas dimensions

    this.cats = SLOTS.map((slot, i) => this._makeCat(i, slot));
  }

  _makeCat(i, slot) {
    const fromLeft = i < 2;
    const homeX    = slot * this._W;
    return {
      color:     COLORS[i],
      homeX,
      x:         fromLeft ? -160 - i * 90 : this._W + 160 + (i - 2) * 90,
      targetX:   homeX,
      state:     'entering',
      flip:      !fromLeft,
      jumpOff:   0,
      jumpVel:   0,
      tailPhase: Math.random() * TWO_PI,
      footPhase: Math.random() * TWO_PI,
    };
  }

  _resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this._W       = this.canvas.width;
    this._H       = this.canvas.height;
    this._groundY = this._H - BAR_AREA_H - 10;

    if (this.cats) {
      SLOTS.forEach((slot, i) => {
        this.cats[i].homeX = slot * this._W;
        if (this.cats[i].state === 'idle') {
          this.cats[i].targetX = this.cats[i].homeX;
          this.cats[i].x       = this.cats[i].homeX;
        }
      });
    }
  }

  // ── Public interface ──────────────────────────────────────────────────────

  enable() {
    this.active = true;
    if (!this._rafId) {
      this._lastTs = performance.now();
      this._rafId  = requestAnimationFrame(ts => this._loop(ts));
    }
  }

  disable() {
    this.active = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  onBeat(energy) {
    this.energy = energy;
    this._beatCount++;

    // Spike the beat bars
    for (const bar of this.bars) {
      bar.target = 0.20 + (0.35 + energy * 0.55) * (0.5 + Math.random() * 0.5);
    }

    // Cats jump and flip on each beat
    for (const cat of this.cats) {
      if (cat.state === 'idle') {
        cat.jumpVel = JUMP_VEL * (0.7 + energy * 0.3);
        cat.flip    = !cat.flip;
      }
    }

    // Every 9-13 beats, a random idle cat walks off and re-enters
    if (this._beatCount >= this._nextWalk) {
      this._beatCount = 0;
      this._nextWalk  = 9 + Math.floor(Math.random() * 5);
      const idle = this.cats.filter(c => c.state === 'idle');
      if (idle.length > 1) {
        const cat   = idle[Math.floor(Math.random() * idle.length)];
        cat.state   = 'exiting';
        cat.targetX = cat.x > this._W / 2 ? this._W + 170 : -170;
      }
    }
  }

  onTrackChange(features) {
    if (features) this.energy = features.energy ?? 0.5;
  }

  destroy() {
    this.disable();
    window.removeEventListener('resize', this._onResize);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _loop(ts) {
    if (!this.active) { this._rafId = null; return; }
    this._rafId = requestAnimationFrame(t => this._loop(t));
    const dt    = Math.min((ts - this._lastTs) / 1000, 0.1);
    this._lastTs = ts;
    this._update(dt);
    this._draw();
  }

  _update(dt) {
    this._t += dt;

    // Beat bars: decay toward gentle idle oscillation
    for (const bar of this.bars) {
      const idle = 0.10 + Math.sin(this._t * 2.2 + bar.phase) * 0.04;
      bar.target  = lerp(bar.target, idle, dt * 3);
      bar.h       = lerp(bar.h, bar.target, dt * 9);
    }

    // Cats
    for (const cat of this.cats) {
      // Tail sways — faster while airborne
      const tailMult = cat.jumpOff < -8 ? 2.8 : 1;
      cat.tailPhase += dt * 3.0 * tailMult;

      // Jump physics — gravity brings cat back to ground
      if (cat.jumpVel !== 0 || cat.jumpOff < 0) {
        cat.jumpVel += GRAVITY * dt;
        cat.jumpOff += cat.jumpVel * dt;
        if (cat.jumpOff >= 0) { cat.jumpOff = 0; cat.jumpVel = 0; }
      }

      // Walking animation
      if (cat.state === 'entering' || cat.state === 'exiting') {
        const dir   = cat.targetX > cat.x ? 1 : -1;
        cat.x          += dir * WALK_SPEED * dt;
        cat.flip        = dir < 0;
        cat.footPhase  += dt * 11;

        const arrived = dir > 0 ? cat.x >= cat.targetX : cat.x <= cat.targetX;
        if (arrived) {
          cat.x = cat.targetX;
          if (cat.state === 'entering') {
            cat.state = 'idle';
          } else {
            // Re-enter from opposite side
            const goLeft = cat.targetX > this._W / 2;
            cat.x       = goLeft ? -160 : this._W + 160;
            cat.targetX = cat.homeX;
            cat.state   = 'entering';
            cat.flip    = !goLeft;
          }
        }
      } else {
        // Idle: very subtle foot bob
        cat.footPhase += dt * 1.6;
      }
    }
  }

  _draw() {
    const { ctx } = this;
    const W = this._W, H = this._H;

    ctx.clearRect(0, 0, W, H);

    // Dark background — cats need their own bg since the viz canvas is hidden
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#080810');
    bg.addColorStop(1, '#040408');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle stage floor line
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, this._groundY + 4);
    ctx.lineTo(W, this._groundY + 4);
    ctx.stroke();

    // Beat bar glow (soft halo above bars)
    const hue  = window.VIZ_HUE ?? 200;
    const glow = ctx.createLinearGradient(0, H - BAR_AREA_H - 40, 0, H - BAR_AREA_H);
    glow.addColorStop(0, 'rgba(0,0,0,0)');
    glow.addColorStop(1, `hsla(${hue}, 70%, 25%, 0.18)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, H - BAR_AREA_H - 40, W, 40);

    // Cats — sort by x so rightward cat is drawn on top when paths cross
    const sorted = [...this.cats].sort((a, b) => Math.abs(a.x - W / 2) - Math.abs(b.x - W / 2));
    for (const cat of sorted) {
      drawCat(ctx, cat.x, this._groundY, cat.color, cat.flip,
              cat.jumpOff, cat.tailPhase, cat.footPhase,
              cat.state !== 'idle');
    }

    // Beat bars
    drawBeatBars(ctx, this.bars, 0, H - BAR_AREA_H, W, BAR_AREA_H, hue);

    // Thin separator between cats and bars
    ctx.fillStyle = `hsla(${hue}, 60%, 50%, 0.08)`;
    ctx.fillRect(0, H - BAR_AREA_H, W, 1);
  }
}
