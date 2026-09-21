// expo-audio stub for the web harness — the RN-audio fallback player
// (iOS/web path in expo-audio-player.ts). Silent; real audio output is
// device-only. Honors the calls so playback state machinery exercises.

export type AudioStatus = {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish?: boolean;
};

export type AudioPlayer = {
  playing: boolean;
  currentTime: number;
  duration: number;
  play(): void;
  pause(): void;
  seekTo(seconds: number): Promise<void> | void;
  remove(): void;
  release(): void;
  replace(source: unknown): void;
  addListener(event: 'playbackStatusUpdate', cb: (s: AudioStatus) => void): { remove(): void };
};

export function createAudioPlayer(_source: unknown): AudioPlayer {
  const listeners = new Set<(s: AudioStatus) => void>();
  const player: AudioPlayer = {
    playing: false,
    currentTime: 0,
    duration: 0,
    play() {
      this.playing = true;
      for (const l of listeners) {
        l({ playing: true, currentTime: 0, duration: 64 });
      }
    },
    pause() {
      this.playing = false;
    },
    seekTo(s: number) {
      this.currentTime = s;
    },
    remove() {},
    release() {},
    replace(_s: unknown) {},
    addListener(_e: 'playbackStatusUpdate', cb: (s: AudioStatus) => void) {
      listeners.add(cb);
      return { remove: () => listeners.delete(cb) };
    },
  };
  return player;
}

export function setAudioModeAsync(_mode: unknown): Promise<void> {
  return Promise.resolve();
}
