// Beat maths shared by the composition and the generator.

export const framesPerBeat = (bpm: number, fps: number) => (60 / bpm) * fps;

export const beatsToFrames = (beats: number, bpm: number, fps: number) =>
  Math.round(beats * framesPerBeat(bpm, fps));

/** Fractional beat position (0 on the first downbeat) for a frame. */
export const beatAt = (frame: number, bpm: number, fps: number, offsetMs = 0) =>
  (frame - (offsetMs / 1000) * fps) / framesPerBeat(bpm, fps);
