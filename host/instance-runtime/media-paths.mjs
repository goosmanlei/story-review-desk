/** Pure compatibility mapping. Logical legacy recipe paths never address the old project root. */
export function instanceCandidateRelativePath(logicalPath, familyId) {
  const invalid = (message) => { const error = new Error(message); error.code = 'INVALID_MEDIA_PATH'; throw error; };
  if (typeof logicalPath !== 'string' || logicalPath.includes('\\') || logicalPath.includes('\0')
    || logicalPath.split('/').some((part) => !part || part === '.' || part === '..')) invalid('Candidate path must be normalized and relative');
  const segments = logicalPath.split('/');
  // Published audio recipes retain the intended formal filename and hash.
  // Only this explicit audio compatibility case may omit _review_pending.
  if (logicalPath.startsWith('production/generated/05_audio/') && !segments.includes('_review_pending')) {
    if (typeof familyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(familyId)
      || !/\.(wav|mp3|pcm|ogg|opus)$/i.test(segments.at(-1))) invalid('Legacy audio target requires an exact audio family');
    return `media/_review_pending/${familyId}/${segments.at(-1)}`;
  }
  if (!segments.slice(0, -1).includes('_review_pending')) invalid('Candidate path must include a _review_pending directory');
  if (logicalPath.startsWith('media/')) return logicalPath;
  if (logicalPath.startsWith('production/generated/')) return `media/_review_pending/legacy-targets/${logicalPath}`;
  return invalid('Candidate path must use the instance media namespace or an explicit legacy production target');
}
