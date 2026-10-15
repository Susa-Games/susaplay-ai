# Ads — `SusaPlaySDK.Ads`

The game asks the SusaPlay page to show an ad and awaits the answer. The SDK never loads an ad
itself; which network runs is the platform's decision from the game's ad settings.

```csharp
var result = await SusaPlaySDK.Ads.ShowRewarded();
if (result.Rewarded)
{
    // Watched to the end: grant the game's own reward (an extra life, a doubled score).
}
else
{
    Debug.Log($"No reward: {result.Reason}");
}

// Platform coins the platform credited for this ad — informational only.
Debug.Log($"Coins: {result.CoinsAwarded}");

var interstitial = await SusaPlaySDK.Ads.ShowInterstitial();
```

`AdResult`: `Success` (the ad played to the end), `Rewarded` (a rewarded ad was watched to the
end), `CoinsAwarded` (platform coins credited for it, or 0), `Reason` (why it failed, or null),
`AdType`, `RequestId`.

- **Grant the game's reward on `Rewarded`.** It means the ad was watched to the end — for a guest
  too, and whatever the platform's coin limits. The page reports it this way, so this holds for
  every SDK version; SDK 1.10.0 adds `CoinsAwarded`. Code written to expect `Rewarded` false at a
  daily cap must not rely on that any more.
- **Platform coins are the platform's reward, not the game's.** SusaPlay sets the amount, the
  daily limit and the cooldown, the same for every game, and only signed-in players earn them.
  They are already in the wallet: never add coins for an ad, and never make the game's reward
  depend on `CoinsAwarded`.
- An interstitial never rewards: `Rewarded` is always false.
- `Reason` `ADS_DISABLED`: ads are turned off in the game's ad settings (interstitials too).
  `TIMEOUT`: no answer within 180 seconds. Other values come from the page or the ad network,
  such as `H5_AD_TIMEOUT` or `ADS_UNAVAILABLE`.
- The ad settings are managed by SusaPlay; the developer contacts SusaPlay to change them.
