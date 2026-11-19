import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getMint,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

describe("simple_vault — week 10: CPI and withdrawal", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const userWithoutCard = Keypair.generate();

  const UNIT = 1_000_000;

  let tokenMint: PublicKey;
  let vaultStatePda: PublicKey;
  let vaultTokenAccountPda: PublicKey;
  let shareMintPda: PublicKey;

  const tokenAccounts = new Map<string, PublicKey>();
  const shareAccounts = new Map<string, PublicKey>();

  const key = (user: Keypair) => user.publicKey.toBase58();

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePda.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  async function fundUser(user: Keypair) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx, [admin]);
  }

  async function deposit(user: Keypair, amount: number) {
    return program.methods
      .deposit(new anchor.BN(amount))
      .accounts({
        vaultState: vaultStatePda,
        userCard: cardPda(user.publicKey),
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        userTokenAccount: tokenAccounts.get(key(user)),
        userShareAccount: shareAccounts.get(key(user)),
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();
  }

  async function withdraw(user: Keypair, sharesAmount: number) {
    return program.methods
      .withdraw(new anchor.BN(sharesAmount))
      .accounts({
        vaultState: vaultStatePda,
        userCard: cardPda(user.publicKey),
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        userTokenAccount: tokenAccounts.get(key(user)),
        userShareAccount: shareAccounts.get(key(user)),
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();
  }

  before(async () => {
    await fundUser(userA);
    await fundUser(userB);
    await fundUser(userWithoutCard);

    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    [vaultStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePda,
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        tokenMint,
        admin: admin.publicKey,
      } as any)
      .rpc();

    for (const user of [userA, userB]) {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePda,
          userCard: cardPda(user.publicKey),
          user: user.publicKey,
        } as any)
        .signers([user])
        .rpc();
    }

    for (const user of [userA, userB, userWithoutCard]) {
      const tokenAccount = await createAccount(
        provider.connection,
        admin,
        tokenMint,
        user.publicKey
      );
      const shareAccount = await createAccount(
        provider.connection,
        admin,
        shareMintPda,
        user.publicKey
      );

      tokenAccounts.set(key(user), tokenAccount);
      shareAccounts.set(key(user), shareAccount);

      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        tokenAccount,
        admin,
        1_000 * UNIT
      );
    }

    // Подготавливаем vault: A получает 100 shares, B получает 50 shares.
    await deposit(userA, 100 * UNIT);
    await deposit(userB, 50 * UNIT);
  });

  it("withdraw: A сжигает 40 shares и получает 40 токенов", async () => {
    const userTokensBefore = (
      await getAccount(provider.connection, tokenAccounts.get(key(userA))!)
    ).amount;

    await withdraw(userA, 40 * UNIT);

    const userTokensAfter = (
      await getAccount(provider.connection, tokenAccounts.get(key(userA))!)
    ).amount;
    const userShares = await getAccount(
      provider.connection,
      shareAccounts.get(key(userA))!
    );
    const vaultTokens = await getAccount(
      provider.connection,
      vaultTokenAccountPda
    );
    const vault = await program.account.vaultState.fetch(vaultStatePda);
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const shareMint = await getMint(provider.connection, shareMintPda);

    assert.equal(userTokensAfter - userTokensBefore, BigInt(40 * UNIT));
    assert.equal(userShares.amount, BigInt(60 * UNIT));
    assert.equal(vaultTokens.amount, BigInt(110 * UNIT));
    assert.equal(vault.totalTokens.toNumber(), 110 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 110 * UNIT);
    assert.equal(card.deposited.toNumber(), 60 * UNIT);
    assert.equal(card.shares.toNumber(), 60 * UNIT);
    assert.equal(shareMint.supply, BigInt(110 * UNIT));
  });

  it("withdraw: нулевая сумма отклоняется", async () => {
    let failed = false;
    try {
      await withdraw(userA, 0);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "вывод 0 shares должен быть отклонён");
  });

  it("withdraw: нельзя вывести больше shares, чем записано в UserCard", async () => {
    let failed = false;
    try {
      await withdraw(userA, 61 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "вывод сверх shares пользователя должен быть отклонён");
  });

  it("withdraw: пользователь без UserCard не может вывести токены", async () => {
    let failed = false;
    try {
      await withdraw(userWithoutCard, 1 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "вывод без UserCard должен быть отклонён");
  });

  it("withdraw: после неуспешных вызовов состояние vault не изменилось", async () => {
    const vault = await program.account.vaultState.fetch(vaultStatePda);
    const vaultTokens = await getAccount(
      provider.connection,
      vaultTokenAccountPda
    );
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));

    assert.equal(vault.totalTokens.toNumber(), 110 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 110 * UNIT);
    assert.equal(vaultTokens.amount, BigInt(110 * UNIT));
    assert.equal(card.deposited.toNumber(), 60 * UNIT);
    assert.equal(card.shares.toNumber(), 60 * UNIT);
  });

  it("withdraw: B сжигает все 50 shares и получает 50 токенов", async () => {
    const userTokensBefore = (
      await getAccount(provider.connection, tokenAccounts.get(key(userB))!)
    ).amount;

    await withdraw(userB, 50 * UNIT);

    const userTokensAfter = (
      await getAccount(provider.connection, tokenAccounts.get(key(userB))!)
    ).amount;
    const userShares = await getAccount(
      provider.connection,
      shareAccounts.get(key(userB))!
    );
    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));
    const vault = await program.account.vaultState.fetch(vaultStatePda);

    assert.equal(userTokensAfter - userTokensBefore, BigInt(50 * UNIT));
    assert.equal(userShares.amount, BigInt(0));
    assert.equal(card.deposited.toNumber(), 0);
    assert.equal(card.shares.toNumber(), 0);
    assert.equal(vault.totalTokens.toNumber(), 60 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 60 * UNIT);
  });

  it("withdraw: A выводит оставшиеся 60 shares, vault становится пустым", async () => {
    const userTokensBefore = (
      await getAccount(provider.connection, tokenAccounts.get(key(userA))!)
    ).amount;

    await withdraw(userA, 60 * UNIT);

    const userTokensAfter = (
      await getAccount(provider.connection, tokenAccounts.get(key(userA))!)
    ).amount;
    const userShares = await getAccount(
      provider.connection,
      shareAccounts.get(key(userA))!
    );
    const vaultTokens = await getAccount(
      provider.connection,
      vaultTokenAccountPda
    );
    const vault = await program.account.vaultState.fetch(vaultStatePda);
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const shareMint = await getMint(provider.connection, shareMintPda);

    assert.equal(userTokensAfter - userTokensBefore, BigInt(60 * UNIT));
    assert.equal(userShares.amount, BigInt(0));
    assert.equal(vaultTokens.amount, BigInt(0));
    assert.equal(vault.totalTokens.toNumber(), 0);
    assert.equal(vault.totalShares.toNumber(), 0);
    assert.equal(card.deposited.toNumber(), 0);
    assert.equal(card.shares.toNumber(), 0);
    assert.equal(shareMint.supply, BigInt(0));
  });
});
