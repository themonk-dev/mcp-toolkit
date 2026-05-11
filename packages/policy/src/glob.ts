const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * Convert a simple glob to RegExp. Supports `*` (within path segments) and `**` (cross `/` when pathMode).
 */
export function globToRegex(pattern: string, pathMode: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
      continue;
    }
    if (c === '*') {
      re += pathMode ? '[^/]*' : '.*';
      continue;
    }
    if (c === '?') {
      re += pathMode ? '[^/]' : '.';
      continue;
    }
    re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`);
}

export function globMatches(
  pattern: string,
  value: string,
  pathMode: boolean,
): boolean {
  try {
    return globToRegex(pattern, pathMode).test(value);
  } catch {
    return false;
  }
}
