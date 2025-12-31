-- Prompts table
CREATE TABLE public.prompts (
  id uuid primary key default gen_random_uuid(),
  word text not null unique,
  category text,
  is_active boolean not null default true
);
