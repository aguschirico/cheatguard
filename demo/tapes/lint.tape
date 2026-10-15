# cheatguard lint: only the diagnostics your change introduced
Output site/assets/demo-lint.gif
Output site/assets/demo-lint.mp4
Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "export PATH=$PWD/demo/.work/bin:$PATH PS1='$ ' GIT_PAGER=cat && cd demo/.work/legacy && clear"
Enter
Show

Type "# What an agent reads today after editing one file in a legacy repo:"
Enter
Type "npx tsc --noEmit | wc -l"
Enter
Sleep 4s
Type "npx tsc --noEmit | head -n 12"
Enter
Sleep 4s
Type "clear"
Enter
Type "# What it reads with cheatguard: only what it just broke."
Enter
Type "cheatguard lint"
Enter
Sleep 9s
