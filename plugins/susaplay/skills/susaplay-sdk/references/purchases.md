# Wallet, store and purchases — `SusaPlaySDK.Purchases`

Every balance and inventory change happens on the server. The game reads state and asks for a
transaction; it never writes a balance and never grants an item before the platform confirms.

## Reading

| Call | Returns | Fields |
| --- | --- | --- |
| `GetPlatformWallet()` | `PlatformWalletResult` | `Success`, `Wallet` (`coins`, `gems`, `walletScope`, `version`), `Error` |
| `GetStoreItems()` | `StoreCatalogResult` | `Success`, `Currencies`, `Items`, `Error` |
| `GetTopupPacks()` | `TopupPacksResult` | `Success`, `Packs`, `Error` |
| `GetInventory()` | `InventoryResult` | `Success`, `Items`, `Consumables`, `Error` |

Store items and top-up packs come from the game's economy in the Developer Portal. A top-up pack's
`currency` and `amount` are what the player **receives**; `priceAmount` and `priceCurrency` are
what it **costs** (use `priceAmountMinor` for arithmetic).

## Spending wallet balance

```csharp
var result = await SusaPlaySDK.Purchases.SpendPlatformWallet("sword_of_fire");
if (result.Success)
{
    // Granted on the server. result.Inventory and result.Wallet hold the new state.
}
else
{
    Debug.LogWarning(result.Error);
}
```

`PlatformWalletSpendResult`: `Success`, `Wallet`, `Inventory`, `Consumables`, `Error`. The price is
read on the server inside the same transaction.

`ConsumeItem(itemId, quantity = 1)` uses up a consumable: `ConsumeResult` has `Success`, `ItemId`,
`Remaining`, `Consumables`, `Error`.

## Real-money checkout

The SusaPlay page runs checkout. The game starts it and awaits the outcome:

```csharp
var purchase = await SusaPlaySDK.Purchases.StartDirectItemPurchase("starter_pack");
var topup = await SusaPlaySDK.Purchases.StartWalletTopupPurchase("coins_100");
if (purchase.Success)
{
    // Paid, and the item is already credited on the server.
}
```

`PurchaseResult`: `Success` (paid and credited), `Status`, `WalletScope`, `Wallet`,
`PlatformWallet`, `RequestId`, `ErrorCode`, `ErrorMessage`.

| `Status` | Meaning |
| --- | --- |
| `paid` | Payment completed and credited |
| `canceled`, `dismissed` | The player canceled or closed checkout |
| `auth-dismissed` | A guest declined to sign in, which checkout requires |
| `token-failed` | Checkout could not start; `ErrorMessage` says why — for example "Durable item is already owned" |
| `timeout` | No answer within 180 seconds |

- The call can wait up to 3 minutes while the player is in checkout. Show a waiting state; do
  not block the game.
- Entitlements are granted on the server when the payment completes, not by this return value.
  A purchase can still complete after the player closes the tab — re-read the wallet and the
  inventory on the next session.
- Check the inventory before offering a durable item the player may already own.

## Sandbox

Every checkout method takes `sandbox: true`, which **requests** the test lane:

```csharp
await SusaPlaySDK.Purchases.StartDirectItemPurchase("starter_pack", sandbox: true);
```

The server grants it only to the game's own developer and to SusaPlay admins; for anyone else
the purchase is live. Sandbox purchases credit a separate test wallet; `WalletScope` says
`live` or `sandbox`.

## Naming

- The SDK's API is not named after any payment provider. Since SDK 1.5.0 it is `StartPurchase`
  and `PurchaseResult` (the old `StartXsollaPurchase` and `XsollaPurchaseResult` were removed
  without aliases — a game still using them must be updated).
- Never describe the payment provider as SusaPlay's payment processor, and never say SusaPlay is
  the merchant of record. Say "SusaPlay's checkout" if you need a name.
- There are no in-app purchases for iOS or Android: SusaPlay games are WebGL.
