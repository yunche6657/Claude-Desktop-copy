'use strict';

// Fixed desktop's or / Ln / Rn classify diagnostic-only execution errors as
// healthy. dA separately excludes a terminal interrupt from the hold policy.
const toolDiagnostics = ['AxiosError:', 'File does not exist.', 'FileTooLargeError:',
  'MaxFileReadTokenExceededError:', 'McpToolCallError:', 'Error: ECONNREFUSED',
  'Request was aborted.', 'RipgrepTimeoutError:', 'pdftoppm ', 'EISDIR:',
  "Agent type '", 'PDF file exceeds', 'Working directory "'];

function shouldHoldAfterResult(frame, stopReason) {
  if (stopReason === 'cancelled') return false;
  if (!frame) return stopReason === 'error';
  if (frame.terminal_reason === 'aborted_streaming' || frame.terminal_reason === 'aborted_tools') return false;
  if (frame.subtype === 'success' && !frame.is_error) return false;
  if (frame.subtype === 'error_during_execution' && Array.isArray(frame.errors)) {
    const isDiagnostic = text => typeof text === 'string' && text.startsWith('[ede_diagnostic]');
    if (frame.errors.some(isDiagnostic) && frame.errors.every(text => isDiagnostic(text) ||
        (typeof text === 'string' && toolDiagnostics.some(fragment=>text.includes(fragment))))) return false;
  }
  return true;
}
module.exports = {shouldHoldAfterResult};
