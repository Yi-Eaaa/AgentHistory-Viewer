export type TimelineItem<T> =
  | { type: "message"; key: string; message: T }
  | { type: "tool-group"; key: string; messages: T[] };

export function groupConsecutiveTools<T extends { id: string; kind: string }>(messages: T[]): TimelineItem<T>[];
