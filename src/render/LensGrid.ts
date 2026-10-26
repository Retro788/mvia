/**
 * CPU side of the machine-sight lens: a spring-followed cursor (slightly under-damped, so it
 * overshoots and settles like the reference), an open/close amount that pops in when the cursor
 * enters the map and collapses when it leaves, and a smoothed radius. The tile/debris look itself
 * lives in shaders/composite.ts.
 */
export interface LensInput {
  /** lens wanted (store.lens && pointer over the map) */
  visible: boolean;
  /** map drag in progress: lens shrinks to 70% */
  dragging: boolean;
  /** store.lensRadius, css px */
  radius: number;
}

const SUBSTEP = 1 / 120;

export class LensGrid {
  /** smoothed lens centre, css px relative to the canvas */
  x = 0;
  y = 0;
  /** 0 closed … ~1 open (overshoots a little) */
  amount = 0;
  /** smoothed radius setting, css px */
  radius = 260;

  private vx = 0;
  private vy = 0;
  private va = 0;
  private tx = 0;
  private ty = 0;

  setTarget(x: number, y: number): void {
    this.tx = x;
    this.ty = y;
  }

  update(dt: number, inp: LensInput): void {
    const goal = inp.visible ? (inp.dragging ? 0.7 : 1) : 0;
    // reopening from closed: start at the cursor instead of flying in from the old spot
    if (this.amount < 0.02 && goal > 0) {
      this.x = this.tx;
      this.y = this.ty;
      this.vx = this.vy = 0;
    }
    // semi-implicit Euler on damped springs: a = ω²(target − x) − 2ζω·v
    const wC = 17;
    const zC = 0.6;
    const wA = 10.5;
    const zA = 0.52;
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(SUBSTEP, left);
      left -= h;
      this.vx += (wC * wC * (this.tx - this.x) - 2 * zC * wC * this.vx) * h;
      this.vy += (wC * wC * (this.ty - this.y) - 2 * zC * wC * this.vy) * h;
      this.x += this.vx * h;
      this.y += this.vy * h;
      this.va += (wA * wA * (goal - this.amount) - 2 * zA * wA * this.va) * h;
      this.amount += this.va * h;
    }
    if (this.amount < 0) {
      this.amount = 0;
      this.va = 0;
    }
    if (goal === 0 && this.amount < 0.004 && Math.abs(this.va) < 0.05) this.amount = this.va = 0;
    this.radius += (inp.radius - this.radius) * (1 - Math.exp(-dt * 8));
  }

  /** effective radius in css px */
  get radiusCss(): number {
    return this.radius * this.amount;
  }
}
