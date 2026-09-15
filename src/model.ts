export interface VertexDraft {
  x: string;
  y: string;
}

export interface KeyframeDraft {
  t: string;
  x: string;
  y: string;
}

export interface BoomDraft {
  vertices: VertexDraft[];
  keyframes: KeyframeDraft[];
}

export interface SceneDraft {
  booms: [BoomDraft, BoomDraft];
  forbidden: { vertices: VertexDraft[] };
}

export interface FieldError {
  path: string;
  message: string;
}

export const OBJECT_NAMES = ['1 号吊杆', '2 号吊杆', '静态禁区'];
