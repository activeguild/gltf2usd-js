"""Validate a .usdz/.usda with OpenUSD's validators.  pip install usd-core
usage: python3 test/validate.py out.usdz
"""
import sys
from pxr import Usd, UsdValidation

path = sys.argv[1]
stage = Usd.Stage.Open(path)
if not stage:
    print("FAILED to open", path); sys.exit(1)
for p in stage.Traverse():
    print(" ", p.GetPath(), p.GetTypeName())
reg = UsdValidation.ValidationRegistry()
names = [m.name for m in reg.GetAllValidatorMetadata()]
ctx = UsdValidation.ValidationContext(reg.GetOrLoadValidatorsByName(names))
errs = ctx.Validate(stage)
for e in errs:
    print(f"[{e.GetType()}] {e.GetName()}: {e.GetMessage()}")
print(f"{len(errs)} validation error(s) ({len(names)} validators)")
sys.exit(1 if errs else 0)
