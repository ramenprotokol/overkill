/** Plays a run frame by frame. One frame is one physics step (1/60 s), so 1× is real time. */
export class Player {
  position = 0;
  end = 0;
  speed = 1;
  playing = false;
  private last: number | null = null;
  private raf = 0;

  constructor(
    private readonly draw: (position: number, animate: boolean) => void,
    private readonly changed: () => void,
  ) {}

  load(end: number, position = 0): void {
    this.stop();
    this.end = end;
    this.position = Math.min(position, end);
    // Controls first, so a scrubber's range covers the position before the position is drawn.
    this.changed();
    this.draw(this.position, false);
  }

  play(): void {
    if (this.end <= 0) return;
    if (this.position >= this.end) {
      this.position = 0;
      this.draw(0, false);
    }
    this.playing = true;
    this.last = null;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.changed();
  }

  stop(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.changed();
  }

  toggle(): void {
    if (this.playing) this.stop();
    else this.play();
  }

  seek(position: number): void {
    this.position = Math.max(0, Math.min(this.end, position));
    this.draw(this.position, false);
    this.changed();
  }

  private tick = (now: number): void => {
    if (!this.playing) return;
    // Cap a long gap (a background tab) so the machine doesn't jump.
    const dt = this.last === null ? 0 : Math.min(100, now - this.last);
    this.last = now;
    this.position = Math.min(this.end, this.position + (dt / 1000) * 60 * this.speed);
    this.draw(this.position, true);
    if (this.position >= this.end) {
      this.playing = false;
      this.changed();
      return;
    }
    this.changed();
    this.raf = requestAnimationFrame(this.tick);
  };
}
