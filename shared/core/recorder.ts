export interface Recorder {
  record(kind: string, data: Record<string, unknown>): void;
}
export const nullRecorder: Recorder = { record() {} };
