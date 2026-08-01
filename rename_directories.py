#!/usr/bin/env python3

import os
import sys

print("Renaming * directories to Hiro-*...")

packages_path = "packages"
if not os.path.exists(packages_path):
    print(f"Error: Packages directory not found at {packages_path}")
    sys.exit(1)

original_count = 0
renamed_count = 0

for item in os.listdir(packages_path):
    if item.startswith(''):
        original_count += 1
        old_path = os.path.join(packages_path, item)
        new_name = 'Hiro-' + item[11:]
        new_path = os.path.join(packages_path, new_name)
        
        if os.path.exists(old_path):
            os.rename(old_path, new_path)
            renamed_count += 1
            print(f"  Renamed: {item} -> {new_name}")
        else:
            print(f"  Warning: Directory {old_path} does not exist")

print(f"\nSummary:")
print(f"  Found: {original_count} * directories")
print(f"  Renamed: {renamed_count} directories")
print(f"  Remaining: {original_count - renamed_count} directories")

# List the results
print(f"\nPackages directory after renaming:")
for item in sorted(os.listdir(packages_path)):
    print(f"  - {item}")
