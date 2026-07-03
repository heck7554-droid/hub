// Per-environment configuration — currently set to PRODUCTION
// (project family-hub / xbdklcxsvdbesquodzsu). Upload pwa/ as-is to GoDaddy.
// For local development, change SUPABASE_URL to http://127.0.0.1:54321 and
// ANON_KEY to the local key from `supabase status`.
window.HUB_CONFIG = {
  SUPABASE_URL: 'https://xbdklcxsvdbesquodzsu.supabase.co',
  // "anon public" key — safe to ship; row-level security protects all data
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiZGtsY3hzdmRiZXNxdW9kenN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNzE3MTcsImV4cCI6MjA5ODY0NzcxN30.It2q3taGrHPhF4tVm1p1hDBj7MO8KUvY1QpdHoVL3os',
  VAPID_PUBLIC_KEY: 'BAHqgK8yn4frgKAS-UnyfN6txXjixKsmsXOTL9SuX2p4rPkleeohjskSfReAF5h-3Tsoxm_OSf7LCsRfV_lLvZk',
};
