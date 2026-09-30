// client/lib/auth.ts
export function extractDomain(email: string): string | null {
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  return parts[1].toLowerCase();
}

export function isValidCollegeEmail(email: string): boolean {
  const domain = extractDomain(email);
  if (!domain) return false;
  // Allow .edu domains or institutional domains matching college patterns
  return domain.endsWith(".edu") || domain.endsWith(".ac.in");
}