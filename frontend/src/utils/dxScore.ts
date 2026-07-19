export function parseDxScore(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function getDxStar(dxPercent: number): number {
  if (dxPercent <= 85) {
    return 0;
  }
  if (dxPercent <= 90) {
    return 1;
  }
  if (dxPercent <= 93) {
    return 2;
  }
  if (dxPercent <= 95) {
    return 3;
  }
  if (dxPercent <= 97) {
    return 4;
  }
  return 5;
}

export function getDxStarForScore(
  dxScore: number | null,
  maxDxScore: number | null,
): number | null {
  if (dxScore === null || maxDxScore === null || maxDxScore <= 0) {
    return null;
  }
  return getDxStar((dxScore / maxDxScore) * 100);
}

const NOTE_KEYS = ["tap", "hold", "slide", "touch", "break"] as const;

function noteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/,/g, ""))
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function noteTotal(notes: unknown): number | null {
  if (Array.isArray(notes)) {
    const values = notes.map(noteNumber).filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  if (!notes || typeof notes !== "object") {
    return null;
  }
  const record = notes as Record<string, unknown>;
  const explicit = noteNumber(record.total);
  if (explicit !== null) {
    return explicit;
  }
  if (record.notes !== undefined) {
    const nested = noteTotal(record.notes);
    if (nested !== null) {
      return nested;
    }
  }
  if (record.left !== undefined || record.right !== undefined) {
    const sides = [noteTotal(record.left), noteTotal(record.right)].filter(
      (value) => value !== null,
    );
    return sides.length ? sides.reduce((sum, value) => sum + value, 0) : null;
  }
  const values = NOTE_KEYS.map((key) => noteNumber(record[key])).filter(
    (value) => value !== null,
  );
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function getMaxDxScoreFromNotes(notes: unknown): number | null {
  const total = noteTotal(notes);
  return total !== null && total > 0 ? total * 3 : null;
}
