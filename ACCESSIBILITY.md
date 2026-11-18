# Accessibility

genki's web apps are used by employees across Norwegian public agencies: the portal, where service owners build and publish services; the workspace, where employees use them; the console, where Digdir runs the platform; and the public pages. Everyone must be able to use them, with a keyboard, a screen reader, magnification or on a phone.

## Our commitment

The apps must meet WCAG 2.1 level AA, as Norwegian regulations on universal design of ICT require for the public sector ([regulations](https://www.uutilsynet.no/regelverk/regelverk/266), supervised by Uutilsynet). When the apps are in production, Digdir publishes an accessibility statement for them in [uustatus.no](https://uustatus.no), as the regulations require.

## Where we are

genki is under development and not in production. It has not had a manual accessibility audit yet, so we do not claim conformance. The audit and the fixes are tracked in [#11](https://github.com/digdir/genki/issues/11).

What is in place:

- The apps are built with [Designsystemet](https://designsystemet.no), Digdir's design system, whose components are built for accessibility.
- Automated checks with axe run in the unit tests of the portal and the workspace, about 200 of them. Most tests find elements by their accessible role and name, so a control without a name fails its test.
- The portal, the workspace and the console have a skip link to the main content, and the page language follows the language the person chooses: Norwegian bokmål or English.
- In the workspace, answers and drafts made with AI are marked as such, and the sources of an answer are numbered.

## Known limitations

- Automated checks in tests do not cover focus order, colour contrast in the real theme, zoom and reflow, or how a screen reader reads a page. Those need the manual audit in [#11](https://github.com/digdir/genki/issues/11).
- The apps are tested in current Chrome. Other browsers and assistive technologies have not been tested systematically.
- Generated answers can contain tables, lists and code. How well these read with a screen reader depends on the answer and has not been tested.
- The console is used only by Digdir operators and has no automated accessibility checks yet.

## Report a barrier

If something in genki is hard or impossible to use, tell us:

- Open an issue in this repository with the [bug template](https://github.com/digdir/genki/issues/new/choose). Say which page, what you tried to do, and which browser and assistive technology you used.
- Or contact Digdir through [digdir.no](https://www.digdir.no/digdir/kontakt-oss/943) if you do not use GitHub.

Barriers that stop someone from completing a task are prioritised.
