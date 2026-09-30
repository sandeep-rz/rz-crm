"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import {
  Building2,
  Check,
  ChevronsUpDown,
  Loader2,
  LogOut,
  Menu,
  Plus,
  Settings as SettingsIcon,
  User,
} from "lucide-react";
import { toast } from "sonner";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { CreateWorkspaceDialog } from "@/components/layout/create-workspace-dialog";
import { canCreateWorkspaceFromMemberships } from "@/lib/account/workspace-permissions";

const pageTitles: Record<string, string> = {
  "/dashboard": "dashboard",
  "/inbox": "inbox",
  "/notifications": "notifications",
  "/contacts": "contacts",
  "/reservations": "reservations",
  "/pipelines": "pipelines",
  "/broadcasts": "broadcasts",
  "/automations": "automations",
  "/settings": "settings",
};

function getPageTitleKey(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "dashboard";
}

interface HeaderProps {
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
}

import { useTranslations } from "next-intl";

export function Header({ onOpenSidebar }: HeaderProps) {
  const t = useTranslations("Header");
  const tRoles = useTranslations("Settings.roles");
  const pathname = usePathname();
  const {
    profile,
    profileLoading,
    account,
    accountId,
    accounts,
    switchAccount,
    switchingAccount,
    creatingWorkspace,
    signOut,
  } = useAuth();
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const titleKey = getPageTitleKey(pathname);
  const canCreateWorkspace =
    !profileLoading && canCreateWorkspaceFromMemberships(accounts);
  const showWorkspaceMenu = accounts.length > 1 || canCreateWorkspace;
  const workspaceBusy = switchingAccount || creatingWorkspace;

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  const handleSwitch = async (nextAccountId: string) => {
    try {
      await switchAccount(nextAccountId);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("workspaceSwitchFailed"),
      );
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only. 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={t("openMenu")}
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">
          {t(titleKey as string)}
        </h1>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <ModeToggle />

        {showWorkspaceMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("openWorkspaceMenu")}
              disabled={workspaceBusy}
              className="flex min-w-0 max-w-32 items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none disabled:cursor-wait disabled:opacity-60 sm:max-w-56"
            >
              {switchingAccount ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
              ) : (
                <Building2 className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">
                {account?.name ?? t("workspaceFallback")}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="min-w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("workspaces")}</DropdownMenuLabel>
                {accounts.map((membership) => {
                  const active = membership.account_id === accountId;
                  return (
                    <DropdownMenuItem
                      key={membership.account_id}
                      disabled={active || workspaceBusy}
                      onClick={() => void handleSwitch(membership.account_id)}
                      className="items-start py-2"
                    >
                      <Check className={active ? "mt-0.5 size-4" : "mt-0.5 size-4 opacity-0"} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {membership.account_name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {tRoles(membership.role)}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              {canCreateWorkspace ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setCreateWorkspaceOpen(true)}
                  >
                    <Plus className="size-4" />
                    {t("createWorkspace")}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : account?.name ? (
          <div className="hidden min-w-0 max-w-48 items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-sm text-foreground sm:flex">
            <Building2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{account.name}</span>
          </div>
        ) : null}

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70 sm:gap-3 sm:pl-1 sm:pr-3"
          aria-label={t("openAccountMenu")}
        >
          <Avatar className="size-8">
            {profile?.avatar_url ? (
              <AvatarImage
                src={profile.avatar_url}
                alt={profile.full_name ?? t("defaultAvatar")}
              />
            ) : null}
            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-medium text-foreground sm:inline">
            {profile?.full_name ?? t("defaultUser")}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">
              {profile?.full_name ?? t("defaultUser")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <User className="size-4" />
            {t("menuProfile")}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=whatsapp"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <SettingsIcon className="size-4" />
            {t("menuSettings")}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={signOut}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <LogOut className="size-4" />
            {t("menuSignOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
      />
    </header>
  );
}
