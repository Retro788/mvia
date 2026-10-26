/**
 * Draggable vertical divider for compare mode (left = base year, right = scenario year).
 * Lives inside the map container; the pipeline reads `fraction` every frame.
 */
export class SplitHandle {
  readonly el: HTMLDivElement;
  /** divider position as a fraction of the container width */
  fraction = 0.5;

  private readonly leftYear: HTMLSpanElement;
  private readonly rightYear: HTMLSpanElement;
  private readonly grip: HTMLButtonElement;
  private width = 1;
  private dragId: number | null = null;

  constructor(private readonly container: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'mvia-split is-hidden';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="mvia-split__hit"></div>' +
      '<div class="mvia-split__line"></div>' +
      '<span class="mvia-split__chip mvia-split__chip--l"><i></i><span data-y></span></span>' +
      '<span class="mvia-split__chip mvia-split__chip--r"><i></i><span data-y></span></span>' +
      '<button type="button" class="mvia-split__grip" aria-label="Mover divisor de comparación" title="Arrastra para comparar">' +
      '<span>‹</span><span>›</span></button>';
    this.el = el;
    this.leftYear = el.querySelector('.mvia-split__chip--l [data-y]') as HTMLSpanElement;
    this.rightYear = el.querySelector('.mvia-split__chip--r [data-y]') as HTMLSpanElement;
    this.grip = el.querySelector('.mvia-split__grip') as HTMLButtonElement;
    container.appendChild(el);

    const hit = el.querySelector('.mvia-split__hit') as HTMLDivElement;
    const targets: HTMLElement[] = [hit, this.grip];
    for (const target of targets) {
      target.addEventListener('pointerdown', this.onDown);
      target.addEventListener('pointermove', this.onMove);
      target.addEventListener('pointerup', this.onUp);
      target.addEventListener('pointercancel', this.onUp);
    }
    this.grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') this.setFraction(this.fraction - step);
      else if (e.key === 'ArrowRight') this.setFraction(this.fraction + step);
      else if (e.key === 'Home') this.setFraction(0.04);
      else if (e.key === 'End') this.setFraction(0.96);
      else return;
      e.preventDefault();
      e.stopPropagation(); // don't pan the map
    });
    this.grip.addEventListener('dblclick', () => this.setFraction(0.5));
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragId = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.el.classList.add('is-dragging');
    this.fromClient(e.clientX);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragId) return;
    this.fromClient(e.clientX);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragId) return;
    this.dragId = null;
    this.el.classList.remove('is-dragging');
  };

  private fromClient(clientX: number): void {
    const r = this.container.getBoundingClientRect();
    this.setFraction((clientX - r.left) / Math.max(1, r.width));
  }

  setFraction(f: number): void {
    this.fraction = Math.min(0.96, Math.max(0.04, f));
    this.layout(this.width);
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('is-hidden', !v);
    this.el.setAttribute('aria-hidden', String(!v));
  }

  setYears(base: number, scenario: number): void {
    const l = `${Math.round(base)} · BASE`;
    const r = `${Math.floor(scenario)} · ESCENARIO`;
    if (this.leftYear.textContent !== l) this.leftYear.textContent = l;
    if (this.rightYear.textContent !== r) this.rightYear.textContent = r;
  }

  layout(width: number): void {
    this.width = Math.max(1, width);
    this.el.style.transform = `translateX(${(this.fraction * this.width).toFixed(1)}px)`;
  }
}
