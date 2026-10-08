// A study's back button returns to wherever you opened it from: Today or the Library (with its search and tab).
let last = "/";

export function rememberAppPath(path: string) {
  if (!path.startsWith("/study/")) last = path;
}

export function backTarget(): { to: string; label: string } {
  return last.startsWith("/library") ? { to: last, label: "Library" } : { to: "/", label: "Today" };
}
