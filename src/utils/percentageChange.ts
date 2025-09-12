export const percentageChange = (
  actual: number | null,
  estimated: number | null
): number | null => {
  if (actual === null || estimated === null || estimated === 0) {
    return null;
  }
  const change = ((actual - estimated) / estimated) * 100;
  return Number(change.toFixed(2));
};
