-- Store the workspace timezone beside its currency. Existing workspaces keep
-- their currency and start with UTC; no automation behavior changes here.
ALTER TABLE public.accounts ADD COLUMN default_timezone text;
UPDATE public.accounts SET default_timezone = 'UTC';
ALTER TABLE public.accounts ALTER COLUMN default_timezone SET NOT NULL;

-- All existing signup/workspace creation paths already insert into accounts.
-- Read owner metadata solely as preferences, never as authorization claims.
CREATE FUNCTION public.seed_workspace_defaults() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  metadata jsonb;
  zone text;
  currency text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT raw_user_meta_data INTO metadata FROM auth.users WHERE id = NEW.owner_user_id;
    IF NEW.default_timezone IS NULL THEN
      zone := metadata->>'default_timezone';
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = zone) THEN
        NEW.default_timezone := zone;
      ELSE
        NEW.default_timezone := 'UTC';
      END IF;
    END IF;
    currency := metadata->>'default_currency';
    IF NEW.default_currency = 'USD' AND currency = ANY(ARRAY['USD','EUR','GBP','INR','AUD','CAD','BRL','JPY','CNY','AED','ZAR','NGN','SGD','MXN','COP']) THEN
      NEW.default_currency := currency;
    END IF;
  END IF;
  IF NEW.default_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.default_timezone
  ) THEN
    RAISE EXCEPTION 'Invalid workspace timezone' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.seed_workspace_defaults() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER seed_workspace_defaults BEFORE INSERT OR UPDATE OF default_timezone
ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.seed_workspace_defaults();
NOTIFY pgrst, 'reload schema';
