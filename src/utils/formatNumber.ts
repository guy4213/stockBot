export const formatNumber = (value: number): string => {
  if (value === null || value === undefined) {
    return "";
  }
  return value.toLocaleString("en-GB", {
    minimumFractionDigits: 0,
  });
};

export const formatCurrency = (value: number): string => {
  if (value === null || value === undefined) {
    return "";
  }
  return value.toLocaleString("en-GB", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  });
};
