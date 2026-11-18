        .data
msg:    .asciiz "Product: "
        .text
        .globl main
main:
        li   $v0, 5          # read a
        syscall
        move $s0, $v0
        li   $v0, 5          # read b
        syscall
        move $a1, $v0
        move $a0, $s0
        jal  product
        move $s1, $v0
        li   $v0, 4
        la   $a0, msg
        syscall
        li   $v0, 1
        move $a0, $s1
        syscall
        li   $v0, 10
        syscall
