export function getDeviceId() {
  if (typeof window === "undefined") return undefined;
  let id = localStorage.getItem("xDeviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("xDeviceId", id);
  }
  return id;
}
