# Which small GGUF models are MP-04 candidates for the local extraction runtime

**Date:** 2026-11-08 · **Why:** the first MP-04 run (task r5-5.4c-7, ADR 2026-11-03 §8.3) needs a short list of candidates that fit the runtime budget (3584 MiB, 2 CPUs, llama.cpp, CPU only, AVX2 at most), each with a digest to pin.
**Shelf life:** recheck before every MP-04 run, and whenever a publisher pushes a new commit to a listed repository (the commit below changes; the file digest may too). Hugging Face metadata can change without notice.

## Short answer

Seven candidates from the publishers' own repositories (or `ggml-org`, the llama.cpp maintainers), between 0.8 and 2.5 GB of weights. Nothing here is verified to pass MP-04: the table only fixes what to pin. The licence column is the card's metadata tag, not the licence text; reading the licence text at the pinned commit is an MP-04 threshold and is still to do for every row.

## Facts

All values were read from the Hugging Face Hub API on 2026-11-08: the file list with LFS `sha256` from `https://huggingface.co/api/models/<repo>/tree/main`, and the licence tag and repository commit from `https://huggingface.co/api/models/<repo>`. The download URL to pin is `https://huggingface.co/<repo>/resolve/<commit>/<file>`.

| #   | Repository (publisher)                                                                                                    | File                                | Bytes      | sha256                                                             | Repo commit                                | Licence tag (card metadata, unverified)                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| 1   | [Qwen/Qwen2.5-1.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) (Qwen)                          | `qwen2.5-1.5b-instruct-q4_k_m.gguf` | 1117320736 | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` | `91cad51170dc346986eccefdc2dd33a9da36ead9` | `apache-2.0`                                               |
| 2   | [Qwen/Qwen3-1.7B-GGUF](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF) (Qwen)                                                | `Qwen3-1.7B-Q8_0.gguf`              | 1834426016 | `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a` | `90862c4b9d2787eaed51d12237eafdfe7c5f6077` | `apache-2.0`                                               |
| 3   | [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF) (Qwen)                                                    | `Qwen3-4B-Q4_K_M.gguf`              | 2497280256 | `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` | `bc640142c66e1fdd12af0bd68f40445458f3869b` | `apache-2.0`                                               |
| 4   | [ggml-org/gemma-3-1b-it-GGUF](https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF) (llama.cpp maintainers)                 | `gemma-3-1b-it-Q4_K_M.gguf`         | 806058240  | `8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135` | `f9c28bcd85737ffc5aef028638d3341d49869c27` | `gemma`                                                    |
| 5   | [ggml-org/gemma-3-4b-it-GGUF](https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF) (llama.cpp maintainers)                 | `gemma-3-4b-it-Q4_K_M.gguf`         | 2489757856 | `882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863` | `d0976223747697cb51e056d85c532013931fe52e` | `gemma`                                                    |
| 6   | [microsoft/Phi-3-mini-4k-instruct-gguf](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf) (Microsoft)         | `Phi-3-mini-4k-instruct-q4.gguf`    | 2393231072 | `8a83c7fb9049a9b2e92266fa7ad04933bb53aa1e85136b7b30f1b8000ff2edef` | `a64113399c2f6b8ad3e11c394733a2ddadaa7f33` | `mit`                                                      |
| 7   | [hugging-quants/Llama-3.2-3B-Instruct-Q4_K_M-GGUF](https://huggingface.co/hugging-quants/Llama-3.2-3B-Instruct-Q4_K_M-GGUF) | `llama-3.2-3b-instruct-q4_k_m.gguf` | 2019373920 | `c55a83bfb6396799337853ca69918a0b9bbb2917621078c34570bc17d20fd7a1` | `eb72f2a08dd2b9edd07ffacfe5aa56938b7939b0` | none in the card metadata; the base model's Llama 3.2 licence applies, unverified |

Rejected from the list, with the fact that rejects them:

- `Qwen/Qwen2.5-3B-Instruct-GGUF`: card licence tag `other`, name `qwen-research` (read 2026-11-08), not an open licence for commercial use on its face. Re-admit only after reading the licence text.
- Any Q8_0 of a 4B model (Qwen3-4B 4280404704 bytes, gemma-3-4b 4130226336 bytes): the weights alone exceed the 3584 MiB runtime limit.

Runtime: `ghcr.io/ggml-org/llama.cpp` server image, the index digest the rehearsal pins (`.github/workflows/rehearse-extraction-deploy.yml`). The rehearsal proved only that this image starts `llama-server` with a test model under the frozen limits.

## Applicability to us

- **Memory.** Weights are mapped from the volume and count against the 3584 MiB limit together with the KV cache of the one server-wide window. Rows 3, 5 and 6 (2.4–2.5 GB) leave about 1 GB for the cache and the server; their window must be measured, not assumed. Rows 1, 2, 4 leave room for a larger window.
- **CPU.** The host is assumed to have AVX2 at most. Whether the pinned image picks a CPU backend that runs on that host is **unverified**: check the server's startup log on the disposable host before measuring.
- **Router.** The worker's `LOCAL_MODEL_NAME` is a free label for llama.cpp (it serves one model). The local route's `contextTokens` must equal `EXTRACTION_RUNTIME_CONTEXT_TOKENS`.
- **Reasoning output.** Qwen3 models produce a thinking section by default (stated on their cards, unverified here). MP-04 measures reasoning output; a candidate that spends the answer budget on it fails the empty-answer threshold.

## What could not be established

- The licence **text** at each pinned commit was not read: only the card metadata tag. That is an MP-04 threshold ("licence read at the pinned digest"), so every row is still unverified against it.
- Row 7 is published by `hugging-quants`, not by Meta; Meta's own repositories ship no GGUF that I could find without a gated login. Treat its provenance as lower confidence.
- Ukrainian-language quality of any candidate: no primary source; only MP-03 on the labelled set can answer it.
- Tokens/s, cold load and peak RAM on the target host: not measured; that is MP-04.
