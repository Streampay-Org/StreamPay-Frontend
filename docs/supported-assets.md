# Supported Assets (v1)

StreamPay supports Stellar Native (XLM) and any valid Stellar Classic assets (Alpha-numeric 4 or 12). 

## Asset Types

### 1. Stellar Native (XLM)
- **Code**: `XLM`
- **Trustline**: Required by default for all Stellar accounts. No pre-flight needed.
- **Precision**: 7 decimal places (Stroops).

### 2. Stellar Classic Assets (Custom)
- **Format**: `CODE:ISSUER_ADDRESS`
- **Trustline**: The recipient **must** establish a trustline for the specific asset before a stream can be successfully funded or paid out.
- **Pre-flight Check**: StreamPay-Frontend performs an automated check against Horizon to verify trustline existence.

## Validation

### Issuer Validation

Custom asset issuers are validated using full StrKey checksum verification (CRC16-XMODEM) via `isValidStellarPublicKey`. A valid issuer must:

1. Be exactly 56 characters long
2. Start with `G` (Ed25519 public key version byte)
3. Pass Base32 decoding
4. Pass CRC16-XMODEM checksum verification

This prevents malformed or checksum-invalid issuer addresses from being accepted into the system.

### Native Asset Handling

Native asset strings (`XLM`, `native`, case-insensitive) are handled without issuer validation. Their behavior is unchanged.

## Validation Matrix

| Case | Result | Actionable Error |
| :--- | :--- | :--- |
| Valid XLM | Success | N/A |
| Valid USDC:G... | Success (if trustline exists) | N/A |
| Missing Trustline | Reject | "Missing trustline for [CODE]." |
| Account Not Found | Reject | "Recipient account does not exist on-chain." |
| Invalid Format | Reject | "Invalid asset format. Expected CODE:ISSUER" |
| Bad Checksum | Reject | "Invalid asset format. Expected CODE:ISSUER" |

## Minimum Reserves
Users must maintain the Stellar base reserve + increments for each trustline. StreamPay does not currently sponsor reserves for trustlines in v1.
