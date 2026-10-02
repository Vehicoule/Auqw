// The dock's M3 active indicator (react-native-bottom-tabs →
// Material BottomNavigationView) only draws under a Material3
// theme — the generated AppCompat parent left `itemActiveIndicatorEnabled`
// unresolved, so `activeIndicatorColor` applied to a view that
// never rendered. Theme.Material3.DayNight keeps the app's light/dark
// split; NoActionBar matches the RN chrome. The app renders no
// other theme-styled widgets (no Alert/Switch/datepicker usage), so
// the parent swap only enables the indicator.
const { withAndroidStyles } = require('expo/config-plugins');

module.exports = function withMaterial3Theme(config) {
  return withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults;
    for (const style of styles.resources?.style ?? []) {
      if (style.$?.name === 'AppTheme') {
        style.$.parent = 'Theme.Material3.DayNight.NoActionBar';
      }
    }
    return cfg;
  });
};
