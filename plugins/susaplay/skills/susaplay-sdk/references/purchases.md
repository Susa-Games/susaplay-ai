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

Store items come from the game's economy in the Developer Portal. Each item is priced on a
SusaPlay price tier (a fixed list from $0.99 to $99.99, like app stores); the developer picks the
tier and never enters an amount or a payment SKU. A `StoreItemEntry` carries (SDK 1.11.0+):

| Field | Meaning |
| --- | --- |
| `cashPrice` | The money price: `amount` + `currency` for display, `amountMinor` (499) for comparisons |
| `coinPrice` | The price in SusaPlay coins, or 0 when the item cannot be bought with coins |
| `directPurchaseEnabled` | It can be bought with money now → `StartDirectItemPurchase` |
| `walletPurchaseEligible` | It can be bought with coins now → `SpendPlatformWallet` |
| `price` | Legacy: the coin price in the pre-1.11.0 shape. Prefer `coinPrice` |

Offer a money button when `directPurchaseEnabled`, and a coin button when
`walletPurchaseEligible` — disabled while the balance is below `coinPrice`. Paying with coins is
opt-in per item in the Developer Portal, and **a coin purchase earns the developer nothing**; only
money purchases are paid out. Players get coins from rewarded ads (the platform sets the amount,
which may be 0) and from top-up packs when those are on sale.

Top-up packs (buying coins with money) may be switched off; with none on sale, `GetTopupPacks()`
returns an empty list — hide the section. A pack's `currency` and `amount` are what the player
**receives**; `priceAmount` and `priceCurrency` are what it **costs**.

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

`PlatformWalletSpendResult`: `Success`, `Wallet`, `Inventory`, `Consumables`, `Error`. The server
charges the item's coin price; the game never sends a price. It is refused unless the developer
allowed coins for the item, and for a guest.

`ConsumeItem(itemId, quantity = 1)` uses up a consumable: `ConsumeResult` has `Success`, `ItemId`,
`Remaining`, `Consumables`, `Error`.

## Real-money checkout

The SusaPlay page runs checkout. The game starts it and awaits the outcome:

```csharp
var purchase = await SusaPlaySDK.Purchases.StartDirectItemPurchase("starter_pack");
if (purchase.Success)
{
    // Paid, and the item is already credited on the server.
}

// Top-ups only when a pack is on sale; take the ID from the list.
var packs = await SusaPlaySDK.Purchases.GetTopupPacks();
if (packs.Success && packs.Packs.Length > 0)
{
    var topup = await SusaPlaySDK.Purchases.StartWalletTopupPurchase(packs.Packs[0].topupPackId);
}
```

`PurchaseResult`: `Success` (paid, and the wallet refreshed), `Status`, `WalletScope`, `Wallet`,
`PlatformWallet`, `RequestId`, `ErrorCode`, `ErrorMessage`.

| `Status` | Meaning |
| --- | --- |
| `paid`, `done`, `successful` | Payment completed and credited (the provider's own word) |
| `canceled`, `dismissed` | The player canceled or closed checkout |
| `auth-dismissed` | A guest declined to sign in, which checkout requires |
| `token-failed` | Checkout could not start; `ErrorMessage` says why — for example "Durable item is already owned" |
| `timeout` | No answer within 180 seconds |
| `close`, `return` | Checkout closed and the outcome is not known yet |

Branch on `Success`, not on `Status`, which is for diagnostics. If `Success` is false but the
`Status` says paid (for example `ErrorCode` `WALLET_REFRESH_FAILED`), the payment went through:
re-read the wallet and the inventory.

- The call can wait up to 3 minutes while the player is in checkout. Show a waiting state; do
  not block the game.
- Entitlements are granted on the server when the payment completes, not by this return value.
  A purchase can still complete after the player closes the tab — re-read the wallet and the
  inventory on the next session.
- Check the inventory before offering a durable item the player may already own.
- Always pass the item ID. `StartPurchase()` names no item and is obsolete since SDK 1.11.0: the
  platform refuses it, because many items share one price tier.
- An item that cannot be bought with money right now (its price tier is off sale or not set) is
  refused before checkout opens: `Status` `token-failed`, `ErrorCode` `UPSTREAM_ERROR`, and
  `ErrorMessage` says why. Show the money button only when `directPurchaseEnabled` is true.

## Sandbox

Every checkout method takes `sandbox: true`, which **requests** the test lane:

```csharp
await SusaPlaySDK.Purchases.StartDirectItemPurchase("starter_pack", sandbox: true);
```

The server grants it only to the game's own developer and to SusaPlay admins; for anyone else
the purchase is live. Sandbox purchases credit a separate test wallet; `WalletScope` says
`live` or `sandbox`.

## Naming

- The SDK's API is not named after any payment provider. Since SDK 1.5.0 it is
  `StartDirectItemPurchase` / `StartWalletTopupPurchase` and `PurchaseResult` (the old
  `StartXsollaPurchase` and `XsollaPurchaseResult` were removed without aliases — a game still
  using them must be updated).
- Never describe the payment provider as SusaPlay's payment processor, and never say SusaPlay is
  the merchant of record. Say "SusaPlay's checkout" if you need a name.
- There are no in-app purchases for iOS or Android: SusaPlay games are WebGL.
