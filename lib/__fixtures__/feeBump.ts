import { Account, Asset, Keypair, Operation, SorobanDataBuilder, TransactionBuilder } from "@stellar/stellar-sdk";
import { getNetworkProfile } from "@/app/lib/config/stellar";

/** Generate fresh signed testnet XDR; no reusable private key is stored. */
export function makeInnerTransaction(options: { fee?: number; operations?: number; signed?: boolean; resourceFee?: number } = {}) {
  const source = Keypair.random();
  const payer = Keypair.random();
  const passphrase = getNetworkProfile("testnet").passphrase;
  const builder = new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: String(options.fee ?? 100), networkPassphrase: passphrase,
  });
  if (options.resourceFee !== undefined) {
    builder.addOperation(Operation.restoreFootprint({}));
    builder.setSorobanData(new SorobanDataBuilder().setResourceFee(String(options.resourceFee)).build());
  } else {
    for (let i = 0; i < (options.operations ?? 1); i++) {
      builder.addOperation(Operation.payment({ destination: payer.publicKey(), asset: Asset.native(), amount: "1" }));
    }
  }
  const inner = builder.setTimeout(0).build();
  if (options.signed !== false) inner.sign(source);
  return { source, payer, inner, xdr: inner.toXDR(), hash: inner.hash().toString("hex"), passphrase };
}
