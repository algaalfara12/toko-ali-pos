// packages/api/src/utils/time.ts
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
dayjs.extend(utc);
dayjs.extend(timezone);

/** Format waktu lokal sesuai timezone toko */
export function formatLocal(
  d: Date,
  tz = "Asia/Jakarta",
  fmt = "YYYY-MM-DD HH:mm"
) {
  return dayjs(d).tz(tz).format(fmt);
}
