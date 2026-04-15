# FourMeme Token Transaction Notes

The MVP works with normalized transaction data instead of live RPC reads.

Important fields:

- `from`: transaction actor.
- `to`: target contract or recipient.
- `method`: decoded method name when known.
- `tokenTransfers`: ERC-20 style transfer facts.
- `directionHint`: optional upstream hint when a decoder or domain-specific adapter already identified buy or sell behavior.

For production, a FourMeme plugin should add chain adapters for:

- Fetching transaction receipt and logs.
- Decoding router or launchpad contract calls.
- Resolving known router, pair, launchpad, burn, and exchange addresses.
- Computing holder deltas for a watched wallet or token.
- Fetching liquidity and holder concentration near the transaction block.
