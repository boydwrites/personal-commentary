// The app's mark: an open book with a ribbon. Inline so it scales cleanly at
// every size; web/public/mark.svg is the same drawing for icons and avatars.
export function Mark({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`mark ${className}`} viewBox="0 0 64 64" width={size} height={size} fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M32 19C25 15.5 17 15 10 16V45C17 44 25 44.5 32 48Z" fill="#FFFDF8" stroke="#2B2A33" strokeWidth="2.2" />
      <path d="M32 19C39 15.5 47 15 54 16V45C47 44 39 44.5 32 48Z" fill="#FFFDF8" stroke="#2B2A33" strokeWidth="2.2" />
      <path d="M37 24C41.5 22.6 45.5 22.2 49 22.5M37 29.5C41.5 28.1 45.5 27.7 49 28M37 35C40.5 33.9 43.5 33.6 46 33.8" stroke="#7A5C3E" strokeWidth="1.8" />
      <path d="M15 24C19.5 22.6 23.5 22.6 27 23.6" stroke="#7A5C3E" strokeWidth="1.8" />
      <path d="M35.5 46.2V56L38 53.6L40.5 56V45.4" fill="#B4472F" stroke="#B4472F" strokeWidth="1.6" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="brand">
      <Mark />
      <span className="wordmark">
        Personal <span>Commentary</span>
      </span>
    </span>
  );
}
