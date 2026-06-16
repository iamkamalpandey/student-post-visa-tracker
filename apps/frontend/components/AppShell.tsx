'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AppBar,
  Avatar,
  Box,
  Chip,
  Collapse,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import SchoolOutlinedIcon from '@mui/icons-material/SchoolOutlined';
import HowToRegOutlinedIcon from '@mui/icons-material/HowToRegOutlined';
import ClassOutlinedIcon from '@mui/icons-material/ClassOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined';
import MoveToInboxOutlinedIcon from '@mui/icons-material/MoveToInboxOutlined';
import TimelineOutlinedIcon from '@mui/icons-material/TimelineOutlined';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';
import PolicyOutlinedIcon from '@mui/icons-material/PolicyOutlined';
import PrivacyTipOutlinedIcon from '@mui/icons-material/PrivacyTipOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import HelpOutlineOutlinedIcon from '@mui/icons-material/HelpOutlineOutlined';
import RequestQuoteOutlinedIcon from '@mui/icons-material/RequestQuoteOutlined';
import LogoutIcon from '@mui/icons-material/Logout';
import { useAuth } from '@/lib/auth';
import { useBillingEnabled } from '@/features/billing/queries';
import { useThemeMode } from '@/app/providers';
import NotificationsBell from './NotificationsBell';
import CommandPalette from './CommandPalette';
import KeyboardShortcuts from './KeyboardShortcuts';

const DRAWER_WIDTH = 260;
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Student Post-Visa Tracker';

type NavKey =
  | 'admin'
  | 'billing'
  | 'dashboard'
  | 'students'
  | 'leads'
  | 'calendar'
  | 'inbox'
  | 'institutions'
  | 'programs'
  | 'imports'
  | 'stages'
  | 'visaTypes'
  | 'reports'
  | 'users'
  | 'commissions'
  | 'catalog'
  | 'exports'
  | 'audit'
  | 'dsar'
  | 'consents'
  | 'breaches'
  | 'subProcessors'
  | 'settings';

type NavItem = {
  // Key under the `nav.*` namespace in messages/{locale}.json. The icon + URL stay
  // the same across locales; only the label is translated at render time.
  labelKey: NavKey;
  href: string;
  icon: ReactNode;
  adminOnly?: boolean;
};

// Tightened sidebar — keep only the things a counsellor opens daily.
// Reminders + Expiries + the old Inbox were folded into a single /inbox
// page with three tabs (?tab=tasks|expiring|messages); Calendar stays
// standalone. Admins get a small Admin section; compliance routes live
// behind a collapsible group so the everyday surface stays small.
const PRIMARY_NAV: NavItem[] = [
  { labelKey: 'dashboard', href: '/', icon: <DashboardOutlinedIcon /> },
  { labelKey: 'students', href: '/students', icon: <GroupsOutlinedIcon /> },
  { labelKey: 'leads', href: '/leads', icon: <HowToRegOutlinedIcon /> },
  { labelKey: 'inbox', href: '/inbox', icon: <MoveToInboxOutlinedIcon /> },
  { labelKey: 'calendar', href: '/calendar', icon: <CalendarMonthOutlinedIcon /> },
  { labelKey: 'institutions', href: '/institutions', icon: <SchoolOutlinedIcon /> },
  { labelKey: 'programs', href: '/programs', icon: <ClassOutlinedIcon /> },
  { labelKey: 'imports', href: '/imports', icon: <UploadFileOutlinedIcon /> },
];

// Single Admin entry — admin sub-areas (Stages / Visa types / Users / Commissions /
// Reports / Imports / Exports / Catalog) live behind the /admin tabbed page.
// Routes themselves remain reachable by direct URL.
const ADMIN_NAV: NavItem[] = [
  { labelKey: 'admin', href: '/admin', icon: <SettingsOutlinedIcon />, adminOnly: true },
];

// SVT-WAVE-BILLING-ADMIN-2026-05 — surfaced separately from ADMIN_NAV because
// it is double-gated (admin role + tenant.billing_enabled). When billing is
// off, the entry is hidden entirely; the /billing route itself still renders
// an empty state if reached directly, so deep links don't 404.
const BILLING_NAV: NavItem[] = [
  { labelKey: 'billing', href: '/billing', icon: <RequestQuoteOutlinedIcon />, adminOnly: true },
];

// Compliance: collapsed by default, expandable. Admin only. The corresponding routes
// remain reachable by URL even when the group is collapsed — these are rare admin tasks.
const COMPLIANCE_NAV: NavItem[] = [
  { labelKey: 'audit', href: '/audit', icon: <PolicyOutlinedIcon />, adminOnly: true },
  { labelKey: 'dsar', href: '/dsar', icon: <PrivacyTipOutlinedIcon />, adminOnly: true },
  { labelKey: 'consents', href: '/consents', icon: <FactCheckOutlinedIcon />, adminOnly: true },
  { labelKey: 'breaches', href: '/breach-incidents', icon: <WarningAmberOutlinedIcon />, adminOnly: true },
  { labelKey: 'subProcessors', href: '/sub-processors', icon: <GroupsOutlinedIcon />, adminOnly: true },
];

const SETTINGS_NAV: NavItem[] = [
  { labelKey: 'settings', href: '/settings', icon: <SettingsOutlinedIcon /> },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function initials(name: string | null | undefined, fallback: string): string {
  const src = (name || fallback || '').trim();
  if (!src) return '?';
  const parts = src.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

// Collapsible group for compliance routes — kept off the main daily surface.
// Auto-expands when the active route belongs to the group, so admins drilling in
// don't lose context.
function ComplianceSection({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate: (href: string) => void;
}) {
  const t = useTranslations('nav');
  const childActive = COMPLIANCE_NAV.some((i) => isActive(pathname, i.href));
  const [open, setOpen] = useState(childActive);
  return (
    <>
      <ListItem disablePadding>
        <ListItemButton onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ListItemIcon><GavelOutlinedIcon /></ListItemIcon>
          <ListItemText
            primary={t('compliance')}
            primaryTypographyProps={{ fontSize: 14, fontWeight: childActive ? 600 : 500 }}
          />
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </ListItemButton>
      </ListItem>
      <Collapse in={open} timeout="auto" unmountOnExit>
        <Box sx={{ pl: 2 }}>
          <NavSection items={COMPLIANCE_NAV} pathname={pathname} onNavigate={onNavigate} />
        </Box>
      </Collapse>
    </>
  );
}

function NavSection({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate: (href: string) => void;
}) {
  const t = useTranslations('nav');
  return (
    <List disablePadding sx={{ py: 0.5 }}>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <ListItem key={item.href} disablePadding>
            <ListItemButton
              selected={active}
              onClick={() => onNavigate(item.href)}
              aria-current={active ? 'page' : undefined}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText
                primary={t(item.labelKey)}
                primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 600 : 500 }}
              />
            </ListItemButton>
          </ListItem>
        );
      })}
    </List>
  );
}

function ThemeSwitcher() {
  const { mode, setMode } = useThemeMode();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tCommon = useTranslations('common');
  const Icon =
    mode === 'dark'
      ? DarkModeOutlinedIcon
      : mode === 'system'
        ? SettingsBrightnessIcon
        : LightModeOutlinedIcon;

  return (
    <>
      <Tooltip title="Theme">
        <IconButton
          aria-label={tCommon('aria.changeTheme')}
          onClick={(e) => setAnchor(e.currentTarget)}
          size="medium"
        >
          <Icon />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          selected={mode === 'light'}
          onClick={() => {
            setMode('light');
            setAnchor(null);
          }}
        >
          <ListItemIcon>
            <LightModeOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Light
        </MenuItem>
        <MenuItem
          selected={mode === 'dark'}
          onClick={() => {
            setMode('dark');
            setAnchor(null);
          }}
        >
          <ListItemIcon>
            <DarkModeOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Dark
        </MenuItem>
        <MenuItem
          selected={mode === 'system'}
          onClick={() => {
            setMode('system');
            setAnchor(null);
          }}
        >
          <ListItemIcon>
            <SettingsBrightnessIcon fontSize="small" />
          </ListItemIcon>
          System
        </MenuItem>
      </Menu>
    </>
  );
}

function ProfileMenu() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tCommon = useTranslations('common');

  const display = user?.display_name || `${user?.given_name ?? ''} ${user?.family_name ?? ''}`.trim();
  const role = user?.role ?? 'VIEWER';

  return (
    <>
      <Tooltip title={display || 'Account'}>
        <IconButton
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-label={tCommon('aria.accountMenu')}
          sx={{ p: 0.5 }}
        >
          <Avatar
            sx={{
              width: 36,
              height: 36,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {initials(display, user?.email ?? '?')}
          </Avatar>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        PaperProps={{ sx: { minWidth: 240, mt: 1 } }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }} noWrap>
            {display || 'Signed in'}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {user?.email}
          </Typography>
          <Box sx={{ mt: 1 }}>
            <Chip size="small" label={role} variant="outlined" />
          </Box>
        </Box>
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            router.push('/settings');
          }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Settings
        </MenuItem>
        <Divider />
        {/* SVT-LEGAL-2026-05 — quick access to the legal surface from the
            profile menu so logged-in users can reach Terms / Privacy /
            Support without digging through the public footer. */}
        <MenuItem
          onClick={() => {
            setAnchor(null);
            router.push('/legal/terms');
          }}
        >
          <ListItemIcon>
            <DescriptionOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Terms
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            router.push('/legal/privacy');
          }}
        >
          <ListItemIcon>
            <PrivacyTipOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Privacy
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            router.push('/legal/support');
          }}
        >
          <ListItemIcon>
            <HelpOutlineOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Support
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={async () => {
            setAnchor(null);
            await logout();
            router.replace('/login');
          }}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          Sign out
        </MenuItem>
      </Menu>
    </>
  );
}

function BrandMark() {
  return (
    <Stack direction="row" spacing={1.25} alignItems="center" sx={{ pl: 0.5 }}>
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: '10px',
          background: 'linear-gradient(135deg, #1A73E8 0%, #7E57C2 100%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontWeight: 700,
          fontSize: 14,
          letterSpacing: 0.5,
        }}
        aria-hidden
      >
        SP
      </Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.1 }}>
        {APP_NAME}
      </Typography>
    </Stack>
  );
}

function DrawerContent({
  pathname,
  onNavigate,
  isAdmin,
  billingEnabled,
}: {
  pathname: string;
  onNavigate: (href: string) => void;
  isAdmin: boolean;
  billingEnabled: boolean;
}) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
      }}
      role="navigation"
      aria-label={tCommon('aria.primaryNavigation')}
    >
      <Toolbar sx={{ px: 2.5 }}>
        <BrandMark />
      </Toolbar>
      <Divider />
      <Box sx={{ flexGrow: 1, overflowY: 'auto', py: 1 }}>
        <NavSection items={PRIMARY_NAV} pathname={pathname} onNavigate={onNavigate} />
        {isAdmin && (
          <>
            <Divider sx={{ my: 1.5, mx: 2 }} />
            <Typography
              variant="overline"
              sx={{ px: 3, color: 'text.secondary', display: 'block', mb: 0.5 }}
            >
              {t('admin')}
            </Typography>
            <NavSection items={ADMIN_NAV} pathname={pathname} onNavigate={onNavigate} />
            {billingEnabled ? (
              <NavSection items={BILLING_NAV} pathname={pathname} onNavigate={onNavigate} />
            ) : null}
            {/* SVT-WAVE44-COMPLIANCE-NAV-2026-05 — surfaces the
                previously-orphaned ComplianceSection (audit, DSAR, consents,
                breaches, sub-processors). Routes were always reachable by URL
                but counsellors/admins shouldn't have to remember the slug. */}
            <ComplianceSection pathname={pathname} onNavigate={onNavigate} />
          </>
        )}
        <Divider sx={{ my: 1.5, mx: 2 }} />
        <NavSection items={SETTINGS_NAV} pathname={pathname} onNavigate={onNavigate} />
      </Box>
      <Box sx={{ px: 3, py: 2 }}>
        {/* SVT-LEGAL-2026-05 — minimal legal footer in the drawer. Mirrors
            the links in the profile menu but is always visible. */}
        <Stack direction="row" spacing={1.5} sx={{ mb: 0.75, flexWrap: 'wrap' }}>
          {[
            { href: '/legal/terms', label: 'Terms' },
            { href: '/legal/privacy', label: 'Privacy' },
            { href: '/legal/support', label: 'Support' },
          ].map((l) => (
            <Box
              key={l.href}
              component={Link}
              href={l.href}
              sx={{
                fontSize: 11,
                color: 'text.secondary',
                textDecoration: 'none',
                '&:hover': { textDecoration: 'underline', color: 'primary.main' },
              }}
            >
              {l.label}
            </Box>
          ))}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          v0.1.0 · {new Date().getFullYear()}
        </Typography>
      </Box>
    </Box>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const isMdUp = useMediaQuery(theme.breakpoints.up('md'));
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { user } = useAuth();
  const locale = useLocale();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isAdmin = user?.role === 'ADMIN';
  // SVT-WAVE-BILLING-ADMIN-2026-05 — gate the Billing nav entry behind both
  // the admin role and the tenant.billing_enabled flag. `useBillingEnabled`
  // probes /billing/plans (404 when the module is off) and caches for 5min,
  // so the nav rerenders almost immediately after an admin flips the toggle
  // on /settings (which also invalidates the cache).
  const billingEnabledQuery = useBillingEnabled();
  const billingEnabled = billingEnabledQuery.data === true;
  // In Arabic the writing direction is RTL, so the drawer should anchor to the
  // right (the natural "start" edge in RTL) rather than the physical left.
  const drawerAnchor: 'left' | 'right' = locale === 'ar' ? 'right' : 'left';

  const navigate = useMemo(
    () => (href: string) => {
      if (!isMdUp) setMobileOpen(false);
      router.push(href);
    },
    [isMdUp, router],
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <CommandPalette />
      <KeyboardShortcuts />
      <AppBar
        position="fixed"
        sx={{
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          ml: { md: `${DRAWER_WIDTH}px` },
          zIndex: (t) => t.zIndex.drawer + 1,
        }}
      >
        <Toolbar sx={{ gap: 1, minHeight: { xs: 56, md: 64 }, px: { xs: 2, md: 3 } }}>
          <IconButton
            edge="start"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
            sx={{ display: { md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>
          <Box sx={{ flexGrow: 1, display: { xs: 'block', md: 'none' } }}>
            <BrandMark />
          </Box>
          <Box sx={{ flexGrow: 1, display: { xs: 'none', md: 'block' } }} />
          <NotificationsBell />
          <ThemeSwitcher />
          <ProfileMenu />
        </Toolbar>
      </AppBar>

      {/* Persistent drawer (md+) */}
      <Drawer
        variant="permanent"
        anchor={drawerAnchor}
        sx={{
          display: { xs: 'none', md: 'block' },
          width: DRAWER_WIDTH,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: { width: DRAWER_WIDTH, boxSizing: 'border-box' },
        }}
        open
      >
        <DrawerContent pathname={pathname} onNavigate={navigate} isAdmin={isAdmin} billingEnabled={billingEnabled} />
      </Drawer>

      {/* Temporary drawer (mobile) */}
      <Drawer
        variant="temporary"
        anchor={drawerAnchor}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          [`& .MuiDrawer-paper`]: { width: DRAWER_WIDTH, boxSizing: 'border-box' },
        }}
      >
        <DrawerContent pathname={pathname} onNavigate={navigate} isAdmin={isAdmin} billingEnabled={billingEnabled} />
      </Drawer>

      <Box
        component="main"
        id="main-content"
        tabIndex={-1}
        sx={{
          flexGrow: 1,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Toolbar sx={{ minHeight: { xs: 56, md: 64 } }} />
        <Box sx={{ flexGrow: 1, px: { xs: 2, md: 4 }, py: { xs: 2, md: 4 } }}>{children}</Box>
      </Box>
    </Box>
  );
}
