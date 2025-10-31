// 🔧 FIXED: percentageChange - מטפל נכון במספרים שליליים

export const percentageChange = (
  actual: number | null,
  estimated: number | null
): number | null => {
  // בדיקות בסיסיות
  if (actual === null || estimated === null) {
    return null;
  }
  
  // אם estimated = 0, לא ניתן לחשב אחוז שינוי
  if (estimated === 0) {
    return null;
  }
  
  // 🚨 FIX: אם estimated שלילי, נשתמש ב-absolute value
  // כדי שהכיוון יהיה נכון
  const change = ((actual - estimated) / Math.abs(estimated)) * 100;
  
  return Number(change.toFixed(2));
};

// 🧪 דוגמאות:
/*
1. רגיל - Beat:
   actual = 2.0, estimated = 1.5
   → (2.0 - 1.5) / 1.5 * 100 = +33.33% ✅

2. רגיל - Miss:
   actual = 1.0, estimated = 1.5
   → (1.0 - 1.5) / 1.5 * 100 = -33.33% ✅

3. מהפסד צפוי לרווח (CNC):
   actual = 0.5, estimated = -0.21
   → (0.5 - (-0.21)) / 0.21 * 100 = +338.1% ✅ (לא -338%!)

4. מהפסד להפסד קטן יותר:
   actual = -0.5, estimated = -1.0
   → (-0.5 - (-1.0)) / 1.0 * 100 = +50% ✅

5. מרווח צפוי להפסד:
   actual = -0.5, estimated = 1.0
   → (-0.5 - 1.0) / 1.0 * 100 = -150% ✅
*/