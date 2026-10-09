# Ads — `SusaPlaySDK.Ads`

The game asks the SusaPlay page to show an ad and awaits the answer. The SDK never loads an ad
itself; which network runs, and whether a reward is credited, is the platform's decision from the
game's ad settings.

```csharp
var result = await SusaPlaySDK.Ads.ShowRewarded();
if (result.Rewarded)
{
    // The reward is already in the player's wallet. Refresh the UI only.
}
else if (result.Success)
{
    // The ad played, but no reward was credited this time.
}
else
{
    Debug.Log($"No ad: {result.Reason}");
}

var interstitial = await SusaPlaySDK.Ads.ShowInterstitial();
```

`AdResult`: `Success` (the ad played to the end), `Rewarded` (the reward was credited), `Reason`
(why it failed, or null), `AdType`, `RequestId`.

- **Grant on `Rewarded`, never on `Success`.** An ad can play to the end and credit nothing: the
  daily maximum and the cooldown are checked on the server after it ends.
- The platform credits the reward itself. The game never adds coins for a rewarded ad.
- An interstitial never rewards: `Rewarded` is always false.
- `Reason` `ADS_DISABLED`: ads are turned off in the game's ad settings (interstitials too).
  `TIMEOUT`: no answer within 180 seconds. Anything else comes from the ad network.
- Unset ad settings mean 50 coins per reward, 10 rewards a day, 30 minutes apart. The ad settings
  are managed by SusaPlay; the developer contacts SusaPlay to change them.
