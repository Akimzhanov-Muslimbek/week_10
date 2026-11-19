# Simple Vault — неделя 10: CPI и вывод из Vault

Учебная программа Solana на Anchor 0.31.1. Эта версия продолжает недели 8 и 9 и добавляет вывод базовых токенов из vault в обмен на share-токены.

## Реализованные этапы

### Неделя 8 — каркас Liquidity Vault

- `initialize_vault` создаёт `VaultState` PDA, SPL token account хранилища и `share_mint`.
- `create_user_card` создаёт персональную `UserCard` PDA.
- Для каждого пользователя создаётся отдельная карточка в рамках конкретного vault.

### Неделя 9 — депозит и выпуск shares

Инструкция `deposit(amount)`:

1. Проверяет, что сумма больше нуля.
2. Рассчитывает shares: первый депозит 1:1, последующие — пропорционально `total_shares / total_tokens`.
3. Переводит базовые SPL-токены от пользователя в vault через CPI `transfer`.
4. Выпускает share-токены через CPI `mint_to`, подписывая вызов от имени VaultState PDA.
5. Обновляет агрегированные показатели vault и поля пользовательской карточки.

### Неделя 10 — вывод и CPI

Инструкция:

```rust
withdraw(shares_amount)
```

Пользователь указывает количество share-токенов, которые хочет вернуть vault.

Расчёт суммы к получению:

```text
tokens_out = shares_amount * total_tokens / total_shares
```

Алгоритм:

1. Проверяется, что `shares_amount > 0`.
2. Проверяется, что в vault есть выпущенные shares и что карточка пользователя содержит достаточное количество shares.
3. Рассчитывается `tokens_out` с использованием `u128` и checked arithmetic.
4. CPI `burn` сжигает shares в `user_share_account`. Authority — сам пользователь, который подписывает транзакцию.
5. CPI `transfer` переводит базовые токены из `vault_token_account` на `user_token_account`. Authority токен-аккаунта vault — `VaultState` PDA. Программа подписывает CPI через `CpiContext::new_with_signer` и seeds:
   - `b"vault"`;
   - `token_mint`;
   - сохранённый `bump`.
6. Обновляются `VaultState.total_tokens`, `VaultState.total_shares`, `UserCard.deposited` и `UserCard.shares`.

Все действия выполняются в одной Solana-транзакции. Если CPI `burn` или CPI `transfer` завершается ошибкой, вся транзакция откатывается, включая предшествующие изменения.

Проверки вывода:

- нулевая сумма отклоняется (`ZeroAmount`);
- vault без shares отклоняет вывод (`VaultEmpty`);
- нельзя вывести больше shares, чем записано в `UserCard` (`InsufficientUserShares`);
- нельзя получить нулевое количество базовых токенов (`WithdrawTooSmall`);
- проверяется достаточность токенов в vault (`InsufficientVaultLiquidity`);
- PDA карточки, token accounts, mint и authority проверяются Anchor constraints.

> В этой учебной реализации `UserCard.shares` отражает shares, полученные пользователем через депозит. Перевод share-токенов между пользователями не реализован как синхронизация карточек; для корректной работы пользователь должен выводить shares, учтённые в своей карточке.

## Пример

A вносит 100 токенов и получает 100 shares. B вносит 50 токенов и получает 50 shares. Всего в vault 150 токенов и 150 shares.

- A выводит 40 shares и получает 40 токенов. Остаётся 110 токенов и 110 shares.
- B выводит 50 shares и получает 50 токенов. Остаётся 60 токенов и 60 shares.
- A выводит оставшиеся 60 shares и получает 60 токенов. Vault становится пустым.

## Структура проекта

```text
vault-dev-students-vault-card/
├── programs/
│   └── simple_vault/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs
├── tests/
│   ├── week8.ts
│   ├── week9.ts
│   └── week10.ts
├── Anchor.toml
├── Cargo.toml
├── package.json
└── README.md
```

## Требования

- Rust stable
- Solana CLI 1.18+
- Anchor CLI 0.31.1
- Node.js 18+
- Yarn

## Сборка

```bash
yarn install
anchor build
```

Если используется новый program keypair:

```bash
anchor keys sync
anchor build
```

## Развёртывание и тестирование на devnet

В `Anchor.toml` настроен devnet и кошелёк `~/.config/solana/id.json`.

```bash
solana config set --url devnet
solana address
solana balance
anchor deploy --provider.cluster devnet
yarn test
```

Важно: скрипт `yarn test` запускает `anchor test --provider.cluster devnet --skip-local-validator --skip-deploy`, поэтому сначала необходимо развернуть обновлённую программу.

Администратору потребуется достаточно SOL для deploy и создания тестовых mint/token accounts. Тесты переводят небольшое количество SOL тестовым пользователям.

## Набор тестов

`tests/week8.ts` — проверки создания vault, share mint и UserCard PDA.

`tests/week9.ts` — проверки депозита, выпуска shares, обновления балансов и отказа при некорректных депозитах.

`tests/week10.ts` — проверки:
- частичного вывода shares;
- сжигания share-токенов;
- возврата базовых токенов из vault через CPI transfer с подписью PDA;
- обновления балансов и состояния `UserCard`;
- отклонения нулевого вывода;
- отклонения вывода сверх количества shares в карточке;
- отклонения вывода без карточки;
- полного вывода всеми пользователями и обнуления vault.

Тесты недели 10 создают отдельный тестовый vault, выполняют депозиты A и B, затем проверяют частичный и полный вывод.
