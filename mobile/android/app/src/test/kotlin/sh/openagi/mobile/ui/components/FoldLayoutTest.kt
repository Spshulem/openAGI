package sh.openagi.mobile.ui.components

import org.junit.Assert.*
import org.junit.Test

class FoldLayoutTest {
    @Test fun coverScreenUsesOnePaneAndBottomNavigation() {
        assertFalse(usesNavigationRail(359f, 780f, false))
        assertNull(paneLayout(359f, 700f, null, true, false).supporting)
    }

    @Test fun aMediumWindowUsesARailWithoutForcingTwoNarrowPanes() {
        assertTrue(usesNavigationRail(700f, 780f, false))
        assertNull(paneLayout(620f, 750f, null, true, false).supporting)
    }

    @Test fun aShortLandscapeWindowKeepsBottomNavigation() {
        assertFalse(usesNavigationRail(900f, 411f, false))
        assertNull(paneLayout(900f, 380f, null, true, true).supporting)
    }

    @Test fun anUnfoldedWorkspaceHasTwoReadablePanes() {
        val panes = paneLayout(920f, 800f, null, true, true)
        assertTrue(panes.main.width >= 320f)
        assertTrue(panes.supporting!!.width >= 320f)
        assertEquals(16f, panes.supporting.left - panes.main.right, 0f)
    }

    @Test fun aBookHingeSeparatesWorkAndChat() {
        val fold = FoldInfo(PaneBounds(400f, 0f, 420f, 900f), FoldAxis.VERTICAL)
        val panes = paneLayout(820f, 880f, fold, true, false)
        assertEquals(400f, panes.main.right, 0f)
        assertEquals(420f, panes.supporting!!.left, 0f)
        assertEquals(820f, panes.supporting.right, 0f)
    }

    @Test fun aZeroWidthCreaseStillSeparatesBookPanes() {
        val panes = paneLayout(800f, 900f,
            FoldInfo(PaneBounds(400f, 0f, 400f, 900f), FoldAxis.VERTICAL), true, false)
        assertEquals(400f, panes.main.right, 0f)
        assertEquals(400f, panes.supporting!!.left, 0f)
    }

    @Test fun rightToLeftBookLayoutKeepsThePhysicalHingeInPlace() {
        val panes = paneLayout(820f, 900f,
            FoldInfo(PaneBounds(400f, 0f, 420f, 900f), FoldAxis.VERTICAL), true, false, rtl = true)
        assertEquals(420f, panes.main.left, 0f)
        assertEquals(400f, panes.supporting!!.right, 0f)
    }

    @Test fun tabletopUsesAnUpperWorkPaneAndLowerChatPane() {
        val panes = paneLayout(840f, 820f,
            FoldInfo(PaneBounds(0f, 390f, 840f, 410f), FoldAxis.HORIZONTAL), true, true)
        assertEquals(390f, panes.main.bottom, 0f)
        assertEquals(410f, panes.supporting!!.top, 0f)
        assertFalse(usesNavigationRail(840f, 900f, true))
    }

    @Test fun aSinglePaneScreenDoesNotPlaceControlsAcrossTheHinge() {
        val panes = paneLayout(820f, 900f,
            FoldInfo(PaneBounds(400f, 0f, 420f, 900f), FoldAxis.VERTICAL), false, true)
        assertEquals(400f, panes.main.width, 0f)
        assertNull(panes.supporting)
    }

    @Test fun aHingeOutsideTheCurrentSplitScreenWindowIsIgnored() {
        val panes = paneLayout(359f, 700f,
            FoldInfo(PaneBounds(400f, 0f, 420f, 900f), FoldAxis.VERTICAL), true, false)
        assertEquals(359f, panes.main.width, 0f)
        assertNull(panes.supporting)
    }

    @Test fun aFoldAboveTheCurrentPaneDoesNotSplitItAgain() {
        val panes = paneLayout(840f, 400f,
            FoldInfo(PaneBounds(0f, -200f, 840f, -180f), FoldAxis.HORIZONTAL), true, false)
        assertEquals(400f, panes.main.height, 0f)
        assertNull(panes.supporting)
    }

    @Test fun flatRightToLeftWindowsPutTheMainPaneAtTheLeadingEdge() {
        val panes = paneLayout(1000f, 800f, null, true, true, rtl = true)
        assertEquals(1000f, panes.main.right, 0f)
        assertEquals(0f, panes.supporting!!.left, 0f)
        assertTrue(panes.supporting.right < panes.main.left)
    }
}
