import asyncio
from sharedcache.api import _build_from_settings

PROMPTS = ["a cozy cafe interior", "a modern dental clinic", "a yoga studio at sunrise",
           "a law firm office", "a fresh bakery storefront", "a landscaped backyard garden"]

async def main():
    svc = _build_from_settings().state.service
    for p in PROMPTS:
        r = await svc.generate(p, cache_tolerance=0.15)
        print(f"{r.result:4}  {p}")

if __name__ == "__main__":
    asyncio.run(main())
