'use strict';
// `validId` guards the EXTERNAL id and not the internal one. That asymmetry is correct, and the reason is one line.
//
// THE QUESTION R598 LEFT
//   `hostPending` is written with `key(id)` and read with `key(q.id)`, and `validId(q.id)` is called before the read. Is it
//   also called before the write? If not, a malformed id could be stored and never retrieved — a leak plus the same
//   "prompt reappears" shape R596 found.
//
// THE ANSWER: THERE IS NOTHING TO VALIDATE AT THE WRITE
//       desktop/mcp-stdio-relay.cjs   function request(binding, method, params, {signal, timeoutMs}) { … }
//                                     const id = `relay:${++seq}`;
//                                     … hostPending.set(key(id), entry)
//
//   The id is generated INTERNALLY from a counter. It cannot be malformed, so a check would be dead code. The external id
//   arrives later, in `q.id` from the subprocess's response, and THAT is where `validId` is applied — twice:
//
//       if (Object.hasOwn(q,'id')) { if (!validId(q.id) || originals.has(key(q.id))) throw Error('invalid…') }
//       if (!validId(q.id)) throw Error('invalid response id')
//
//   So the asymmetry is exactly right: validate what crosses the boundary, not what you built yourself.
//
// WHY THIS MATTERED ENOUGH TO CHECK
//   R596 found a map written with a wider key than it was read with. `hostPending` has the same VISUAL shape — two different
//   expressions naming one id — and the check that distinguishes them is the provenance of each side, not the text. One is a
//   counter, the other is subprocess output.
//
//   That is the third time in this line of work that the deciding fact was provenance rather than form: R563 distinguished a
//   replica from a reconstruction by whether it EXECUTES the official slice, and R596's `tabAdmissions` looked like a key
//   rename until both expressions were expanded.
//
// WHAT IS NOT CLAIMED
//   Not that `relay:${++seq}` can never collide: `seq` is per-relay-instance, and two relays feeding one `hostPending` would
//   share the counter only if they shared the closure — which they do not, since `hostPending` is also per-instance. The point
//   is that no check is needed, not that the id is globally unique.
//   Not that the two `validId` sites are the only boundary checks: the module validates `method`, `timeoutMs` and the pending
//   limit in the same guard block. Those are separate concerns and were not part of this question.

/** The id's provenance, and where validation belongs. */
const PROVENANCE = {
  written: {
    expression: 'const id = `relay:${++seq}`;',
    origin: 'internal — a per-relay counter',
    validated: false,
    whyNoValidation: 'a value the module generates cannot be malformed; a check here would be dead code',
  },
  read: {
    expression: 'hostPending.get(key(q.id))',
    origin: 'external — the subprocess\u2019s response',
    validated: true,
    sites: 2,
    whyValidated: 'it crosses a process boundary, so its shape is not guaranteed',
  },
  conclusion: 'the asymmetry is correct: validate what crosses the boundary, not what you built yourself',
};

module.exports = { PROVENANCE };
