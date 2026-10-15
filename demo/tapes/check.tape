# cheatguard check: catching an agent's shortcuts in a diff
Output site/assets/demo-check.gif
Output site/assets/demo-check.mp4
Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "export PATH=$PWD/demo/.work/bin:$PATH PS1='$ ' GIT_PAGER=cat && cd demo/.work/shop && clear"
Enter
Show

Type "# The agent says: 'all tests pass now ✅'. Let's look at what it changed."
Enter
Sleep 800ms
Type "git --no-pager diff --stat"
Enter
Sleep 2s
Type "cheatguard check --no-lint"
Enter
Sleep 7s
